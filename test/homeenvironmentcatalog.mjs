import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const originalEvidenceRoot = path.join(repo, "docs", "evidence", "home-environments", "2026-08-29-pico-emulator-6.0");
const refreshEvidenceRoot = path.join(repo, "docs", "evidence", "home-environments", "2026-08-30-selector-refresh");
const acceptedRefreshEvidenceFiles = [
  "livingroom-day-refresh-call-1.json",
  "livingroom-day-refresh-call-2.json",
  "livingroom-day-refresh-call-3.json",
  "livingroom-day-refresh-call-4.json",
  "livingroom-day-refresh-read-1.json",
  "livingroom-day-refresh-read-2.json",
  "livingroom-day-refresh-read-3.json",
  "livingroom-day-refresh-read-4.json",
  "livingroom-day-selected.png",
  "livingroom-day-selected-2.png",
  "livingroom-day-selected-3.png",
  "livingroom-day-selected-4.png",
  "livingroom-day-selection-provenance-1.json",
  "livingroom-day-selection-provenance-2.json",
  "livingroom-day-selection-provenance-3.json",
  "livingroom-day-selection-provenance-4.json",
  "livingroom-night-refresh-call-1.json",
  "livingroom-night-refresh-read-1.json",
  "livingroom-night-selected.png",
  "livingroom-night-selection-provenance-1.json",
].sort();
const userBriefs = path.join(os.homedir(), ".pico-mcp", "briefs");
const fixtureSuffix = `${process.pid}-${Date.now().toString(36)}`;
const fixtureIds = {
  positive: `catalog-positive-${fixtureSuffix}`,
  absentRoomExperience: `catalog-noswan-${fixtureSuffix}`,
  nonSwanRoomExperience: `catalog-nonswan-${fixtureSuffix}`,
  wrongStage: `catalog-wrongstage-${fixtureSuffix}`,
};
const missingBriefId = `catalog-missing-${fixtureSuffix}`;
let cleanupRegistered = false;

try {
  fs.mkdirSync(userBriefs, { recursive: true });
  for (const id of Object.values(fixtureIds)) assert.equal(fs.existsSync(path.join(userBriefs, `${id}.json`)), false, `fixture brief '${id}' must not already exist`);
  const missionBrief = JSON.parse(fs.readFileSync(path.join(repo, "briefs", "swanmissiontable.json"), "utf8"));
  fs.writeFileSync(path.join(userBriefs, `${fixtureIds.positive}.json`), JSON.stringify({ ...missionBrief, id: fixtureIds.positive }));
  fs.writeFileSync(path.join(userBriefs, `${fixtureIds.absentRoomExperience}.json`), JSON.stringify({ ...missionBrief, id: fixtureIds.absentRoomExperience, spec: (() => {
    const spec = structuredClone(missionBrief.spec);
    delete spec.roomExperience;
    return spec;
  })() }));
  fs.writeFileSync(path.join(userBriefs, `${fixtureIds.nonSwanRoomExperience}.json`), JSON.stringify({ ...missionBrief, id: fixtureIds.nonSwanRoomExperience, spec: {
    ...missionBrief.spec,
    roomExperience: { ...missionBrief.spec.roomExperience, kind: "notSwanMissionTable" },
  } }));
  fs.writeFileSync(path.join(userBriefs, `${fixtureIds.wrongStage}.json`), JSON.stringify({ ...missionBrief, id: fixtureIds.wrongStage, spec: {
    ...missionBrief.spec,
    meta: { ...missionBrief.spec.meta, stageStyle: "3" },
  } }));

  const {
    classifyObservedHomeEnvironment,
    loadPackagedHomeEnvironmentDataset,
    deriveFitRequest,
    homeEnvironmentDatasetSchema,
    rankHomeEnvironments,
  } = await import("../dist/homeenvironmentcatalog.js");
  const { querySceneAnchorsOutputSchema } = await import("../dist/sceneanchors.js");

  const readQuery = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  const livingroomDayQueries = [
    readQuery(originalEvidenceRoot, "livingroom-day-read-1.json"),
    readQuery(refreshEvidenceRoot, "livingroom-day-refresh-read-1.json"),
    readQuery(refreshEvidenceRoot, "livingroom-day-refresh-read-2.json"),
    readQuery(refreshEvidenceRoot, "livingroom-day-refresh-read-3.json"),
    readQuery(refreshEvidenceRoot, "livingroom-day-refresh-read-4.json"),
  ];
  const livingroomNightQueries = [
    readQuery(originalEvidenceRoot, "livingroom-night-read-1.json"),
    readQuery(refreshEvidenceRoot, "livingroom-night-refresh-read-1.json"),
  ];
  const livingroomDayQuery = livingroomDayQueries[0];
  const classificationRequirements = deriveFitRequest({
    requirements: [
      { label: "TABLE", minimumExtentM: [0.25, 0.18] },
      { label: "FLOOR", minimumExtentM: [0.8, 0.55] },
    ],
  });
  const allFixtureRequirements = deriveFitRequest({
    requirements: [
      { label: "TABLE", minimumExtentM: [0.1, 0.1] },
      { label: "FLOOR", minimumExtentM: [0.8, 0.55] },
    ],
  });

  function withLivingroomDayQuery(change) {
    const query = structuredClone(livingroomDayQuery);
    change(query);
    return query;
  }

  function measuredHistogram(environment) {
    return Object.fromEntries(Object.entries(environment.histogramRanges).map(([label, [minimum]]) => [label, minimum]));
  }

  function histogramEnvelope(queries) {
    const labels = [...new Set(queries.flatMap((query) => Object.keys(query.histogram)))].sort();
    return Object.fromEntries(labels.map((label) => {
      const counts = queries.map((query) => query.histogram[label] ?? 0);
      return [label, [Math.min(...counts), Math.max(...counts)]];
    }));
  }

  function totalEnvelope(queries) {
    const counts = queries.map((query) => query.totalAnchorCount);
    return [Math.min(...counts), Math.max(...counts)];
  }

  function extentClusterPresenceEnvelopes(queries, extentClusters, tolerance) {
    return Object.fromEntries(["FLOOR", "TABLE"].map((label) => {
      const clusters = extentClusters[label];
      const countsByQuery = queries.map((query) => {
        const counts = clusters.map(() => 0);
        for (const anchor of query.anchors.filter((entry) => entry.labels.includes(label))) {
          const matchingClusters = clusters.flatMap((cluster, index) =>
            cluster.extentM.every((measured, component) =>
              anchor.boundsM[component] >= measured - tolerance
              && anchor.boundsM[component] <= measured + tolerance)
              ? [index]
              : [],
          );
          assert.equal(
            matchingClusters.length,
            1,
            `${label} ${JSON.stringify(anchor.boundsM)} in ${query.snapshotId} must map to exactly one cluster`,
          );
          counts[matchingClusters[0]] += 1;
        }
        return counts;
      });
      return [label, clusters.map((_, clusterIndex) => {
        const counts = countsByQuery.map((queryCounts) => queryCounts[clusterIndex]);
        return [Math.min(...counts), Math.max(...counts)];
      })];
    }));
  }

  function withoutRefreshExtensions(dataset) {
    const legacy = structuredClone(dataset);
    delete legacy.measurement.refreshProvenance;
    for (const environment of legacy.environments) {
      delete environment.guaranteedSurfaces;
      delete environment.extentClusters;
    }
    return legacy;
  }

  function sha256File(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }

  function nextUp(value) {
    assert.equal(Number.isFinite(value), true, "nextUp test input must be finite");
    if (Object.is(value, -0) || value === 0) return Number.MIN_VALUE;
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0) + (value > 0 ? 1n : -1n);
    view.setBigUint64(0, bits);
    return view.getFloat64(0);
  }

  function nextDown(value) {
    return -nextUp(-value);
  }

  function duplicateAnchor(query, predicate) {
    const source = query.anchors.find(predicate);
    assert.ok(source, "duplicate source anchor must exist");
    const duplicate = structuredClone(source);
    duplicate.traceId = "anchor-9999";
    duplicate.runtimeUuid = `${source.runtimeUuid}-duplicate`;
    query.anchors.push(duplicate);
    query.matchedAnchorCount = query.anchors.length;
  }

  function terminalQuery(status) {
    return querySceneAnchorsOutputSchema.parse({
      status,
      snapshotId: null,
      applicationRuntimeBinding: null,
      queriedAtMonotonicNs: null,
      trackingState: null,
      retries: 0,
      totalAnchorCount: 0,
      matchedAnchorCount: 0,
      geometryRef: null,
      anchors: [],
      histogram: {},
      drift: {
        effectivePolicy: {
          count: "advisory",
          maxTransformDeltaM: 0.01,
          maxTransformDeltaDeg: 1,
          maxExtentDeltaM: 0.01,
          topology: "strict",
        },
        exactSnapshotChanged: false,
        withinPolicy: false,
        countDelta: 0,
        maxTransformDeltaM: 0,
        maxTransformDeltaDeg: 0,
        maxExtentDeltaM: 0,
        labelSetChanges: 0,
        topologyChanges: 0,
        unmatchedPrevious: 0,
        unmatchedCurrent: 0,
        ambiguities: [],
        deltas: [],
      },
      requestedLabels: ["FLOOR", "TABLE"],
      semanticRelationPolicy: {
        labelLevelSelection: true,
        triangleRelations: "refused",
        reason: "semantic_assignment_alignment_unverified",
      },
      actionReceipts: [],
      error: { code: status, detail: `representative ${status} terminal result` },
      evidenceCeiling: "structural",
    });
  }

  test.after(() => {
    for (const id of Object.values(fixtureIds)) fs.rmSync(path.join(userBriefs, `${id}.json`), { force: true });
  });
  cleanupRegistered = true;

  test("loads the sole versioned packaged measurement dataset", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    assert.equal(dataset.datasetId, "pico-emulator-6.0-home-environments-v1");
    assert.deepEqual(fs.readdirSync(path.join(repo, "assets/home-environments")), ["pico-emulator-6.0.v1.json"]);
    assert.equal(dataset.environments.find((entry) => entry.tile === "Mesume Day")?.automaticSelectionEligible, false);
    assert.equal(dataset.environments.find((entry) => entry.tile === "Mesume Day")?.exclusionReason,
      "public query_scene_anchors invalid_payload: stable anchor 33 has zero vertices and indices");
    assert.deepEqual(dataset.measurement.refreshProcedure, {
      procedureVersion: 1,
      requiredRuntime: { host: "macOS", emulatorTitle: "PICO Emulator - 6.0.0", serial: "emulator-5554" },
      steps: [
        "Cold boot emulator-5554 and record the runtime identity before measurement.",
        "Bind emulator-5554 to one QEMU window, validate the 552x440 Environment Preview dialog, and require all six accessible labels.",
        "For every tile, click its AX-layout-derived center only after the binding guards pass and capture the selected dialog hash.",
        "Use a current receipt-bound bridge app to obtain consecutive unfiltered non-empty reads before applying TABLE and FLOOR filters.",
        "Record complete histogram and total-anchor ranges plus every measured FLOOR and TABLE X/Y/Z extent; exclude invalid public payloads.",
      ],
    });
    assert.deepEqual(dataset.picker.measuredTileCenterPointsProvenance, {
      derivation: "derived_from_committed_552x440_dialog_contact_sheet_and_ax_layout",
      exactEmittedCgEventCoordinatesSeparatelyRecorded: false,
      note: "CP1 recorded that target centers were derived from the AX layout; it did not separately record the exact emitted CGEvent coordinates.",
    });
  });

  test("accepts the strict refresh extensions and content-addresses every refresh observation", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const day = dataset.environments.find((entry) => entry.tile === "Livingroom Day");
    const night = dataset.environments.find((entry) => entry.tile === "Livingroom Night");
    const mesumeDay = dataset.environments.find((entry) => entry.tile === "Mesume Day");

    assert.deepEqual(day.guaranteedSurfaces, { FLOOR: [], TABLE: [] });
    assert.deepEqual(day.extentClusters, {
      FLOOR: [
        { extentM: [2.237663, 0.008483, 1.502388], presenceCountRange: [0, 1] },
        { extentM: [6.867676, 0.0000016, 4.439027], presenceCountRange: [0, 1] },
      ],
      TABLE: [
        { extentM: [0.176013, 0.174682, 0.176883], presenceCountRange: [0, 1] },
        { extentM: [0.782631, 0.188127, 0.464378], presenceCountRange: [0, 1] },
      ],
    });
    assert.deepEqual(night.guaranteedSurfaces, {
      FLOOR: [[2.237663, 0.008483, 1.502388], [6.867676, 0.0000016, 4.439027]],
      TABLE: [[0.176013, 0.174682, 0.176883]],
    });
    assert.deepEqual(night.extentClusters, {
      FLOOR: [
        { extentM: [2.237663, 0.008483, 1.502388], presenceCountRange: [1, 1] },
        { extentM: [6.867676, 0.0000016, 4.439027], presenceCountRange: [1, 1] },
      ],
      TABLE: [
        { extentM: [0.176013, 0.174682, 0.176883], presenceCountRange: [1, 1] },
        { extentM: [0.782631, 0.188127, 0.464378], presenceCountRange: [0, 1] },
      ],
    });
    assert.equal(Object.hasOwn(mesumeDay, "guaranteedSurfaces"), false);
    assert.equal(Object.hasOwn(mesumeDay, "extentClusters"), false);

    const provenance = dataset.measurement.refreshProvenance;
    assert.equal(provenance.provenanceVersion, 1);
    assert.equal(provenance.baseDatasetCommit, "7f74b2a0c2ca9aa40b192a93c68b01f04ec94af2");
    assert.equal(new Set(provenance.evidence.map((entry) => entry.path)).size, provenance.evidence.length);
    assert.deepEqual(
      provenance.evidence.map((entry) => path.basename(entry.path)).sort(),
      acceptedRefreshEvidenceFiles,
    );
    assert.equal(provenance.evidence.some((entry) => entry.path.includes("selector-live") || /-40(?:\D|$)/.test(entry.path)), false);
    for (const evidence of provenance.evidence) {
      const evidencePath = path.join(repo, evidence.path);
      assert.equal(path.isAbsolute(evidence.path), false, evidence.path);
      assert.equal(fs.existsSync(evidencePath), true, evidence.path);
      assert.equal(evidence.sha256, sha256File(evidencePath), evidence.path);
      const expectedRole = /-refresh-(?:read|call)-\d+\.json$/.test(evidence.path)
        ? "stable_query"
        : "selected_calibration_provenance";
      assert.equal(evidence.role, expectedRole, evidence.path);
    }
  });

  test("rejects malformed, incomplete, unpinned, and ineligible refresh extensions", async (t) => {
    const source = loadPackagedHomeEnvironmentDataset();
    const refreshedDay = source.environments.find((entry) => entry.tile === "Livingroom Day");
    assert.ok(source.measurement.refreshProvenance, "packaged dataset must expose refresh provenance before mutation checks");
    assert.ok(refreshedDay.guaranteedSurfaces, "packaged Livingroom Day must expose guaranteed surfaces before mutation checks");
    assert.ok(refreshedDay.extentClusters, "packaged Livingroom Day must expose extent clusters before mutation checks");
    const mutations = [
      ["reversed presence range", (dataset) => {
        dataset.environments.find((entry) => entry.tile === "Livingroom Day")
          .extentClusters.FLOOR[0].presenceCountRange = [2, 1];
      }],
      ["never-observed cluster", (dataset) => {
        dataset.environments.find((entry) => entry.tile === "Livingroom Day")
          .extentClusters.FLOOR[0].presenceCountRange = [0, 0];
      }],
      ["non-positive cluster X", (dataset) => {
        dataset.environments.find((entry) => entry.tile === "Livingroom Day")
          .extentClusters.FLOOR[0].extentM[0] = 0;
      }],
      ["negative cluster Y", (dataset) => {
        dataset.environments.find((entry) => entry.tile === "Livingroom Day")
          .extentClusters.FLOOR[0].extentM[1] = -0.001;
      }],
      ["non-finite cluster Z", (dataset) => {
        dataset.environments.find((entry) => entry.tile === "Livingroom Day")
          .extentClusters.FLOOR[0].extentM[2] = Number.POSITIVE_INFINITY;
      }],
      ["empty TABLE clusters", (dataset) => {
        dataset.environments.find((entry) => entry.tile === "Livingroom Day").extentClusters.TABLE = [];
      }],
      ["guaranteed extent not represented by a cluster", (dataset) => {
        dataset.environments.find((entry) => entry.tile === "Livingroom Day")
          .guaranteedSurfaces.TABLE[0] = [1, 0.2, 1];
      }],
      ["optional cluster claimed as guaranteed", (dataset) => {
        dataset.environments.find((entry) => entry.tile === "Livingroom Day")
          .guaranteedSurfaces.TABLE = [[0.176013, 0.174682, 0.176883]];
      }],
      ["unpinned evidence hash", (dataset) => {
        delete dataset.measurement.refreshProvenance.evidence[0].sha256;
      }],
      ["refreshed entry missing guaranteed surfaces", (dataset) => {
        delete dataset.environments.find((entry) => entry.tile === "Livingroom Day").guaranteedSurfaces;
      }],
      ["refreshed entry missing clusters", (dataset) => {
        delete dataset.environments.find((entry) => entry.tile === "Livingroom Night").extentClusters;
      }],
      ["extensions without refresh provenance", (dataset) => {
        delete dataset.measurement.refreshProvenance;
      }],
      ["Mesume Day carrying refresh extensions", (dataset) => {
        const day = dataset.environments.find((entry) => entry.tile === "Livingroom Day");
        const mesume = dataset.environments.find((entry) => entry.tile === "Mesume Day");
        mesume.guaranteedSurfaces = structuredClone(day.guaranteedSurfaces);
        mesume.extentClusters = structuredClone(day.extentClusters);
      }],
    ];

    for (const [name, mutate] of mutations) {
      await t.test(name, () => {
        const changed = structuredClone(source);
        mutate(changed);
        assert.equal(homeEnvironmentDatasetSchema.safeParse(changed).success, false);
      });
    }
  });

  test("derives the exact refreshed Livingroom envelopes from all accepted read fixtures", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const day = dataset.environments.find((entry) => entry.tile === "Livingroom Day");
    const night = dataset.environments.find((entry) => entry.tile === "Livingroom Night");
    const expectedDayHistogram = {
      CABINET: [3, 5], CEILING: [0, 1], CHAIR: [3, 4], DOOR: [1, 2], FLOOR: [1, 2],
      LAMP: [6, 8], PLANT: [1, 3], SCREEN: [0, 1], SOFA: [0, 1], TABLE: [1, 2],
      UNKNOWN: [26, 28], WALL: [1, 2], WALL_ART: [1, 3], WINDOW: [1, 2],
    };
    const expectedNightHistogram = {
      CABINET: [3, 3], CHAIR: [3, 3], DOOR: [0, 2], FLOOR: [2, 2], LAMP: [6, 7],
      PLANT: [3, 3], SCREEN: [0, 1], SOFA: [1, 1], TABLE: [1, 2], UNKNOWN: [25, 26],
      WALL: [3, 3], WALL_ART: [2, 3], WASHING_MACHINE: [1, 1], WINDOW: [2, 2],
    };

    assert.deepEqual(histogramEnvelope(livingroomDayQueries), expectedDayHistogram);
    assert.deepEqual(day.histogramRanges, expectedDayHistogram);
    assert.deepEqual(totalEnvelope(livingroomDayQueries), [51, 60]);
    assert.deepEqual(day.totalAnchorCountRange, [51, 60]);
    assert.equal(day.acceptedInstantiations, livingroomDayQueries.length);

    assert.deepEqual(histogramEnvelope(livingroomNightQueries), expectedNightHistogram);
    assert.deepEqual(night.histogramRanges, expectedNightHistogram);
    assert.deepEqual(totalEnvelope(livingroomNightQueries), [55, 56]);
    assert.deepEqual(night.totalAnchorCountRange, [55, 56]);
    assert.equal(night.acceptedInstantiations, livingroomNightQueries.length);
  });

  test("derives every Livingroom Day cluster presence envelope from all five accepted reads", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const day = dataset.environments.find((entry) => entry.tile === "Livingroom Day");
    assert.equal(livingroomDayQueries.length, 5);
    const derived = extentClusterPresenceEnvelopes(
      livingroomDayQueries,
      day.extentClusters,
      dataset.classification.extentToleranceM,
    );
    const expected = {
      FLOOR: [[0, 1], [0, 1]],
      TABLE: [[0, 1], [0, 1]],
    };

    assert.deepEqual(derived, expected);
    assert.deepEqual(
      Object.fromEntries(Object.entries(day.extentClusters).map(([label, clusters]) => [
        label,
        clusters.map((cluster) => cluster.presenceCountRange),
      ])),
      expected,
    );
  });

  test("keeps historic v1 extension-absent datasets parseable and ranking from legacy surfaces", () => {
    const legacy = withoutRefreshExtensions(loadPackagedHomeEnvironmentDataset());
    assert.equal(homeEnvironmentDatasetSchema.safeParse(legacy).success, true);

    const ranked = rankHomeEnvironments(legacy, deriveFitRequest({
      requirements: [{ label: "TABLE", minimumExtentM: [0.7, 0.4] }],
    }));
    assert.equal(ranked.status, "ranked");
    assert.deepEqual(ranked.candidates.slice(0, 2).map((candidate) => candidate.tile), ["Livingroom Day", "Livingroom Night"]);
  });

  test("derives the Swan Mission Table tiers from its validated AppSpec", () => {
    const mission = deriveFitRequest({ briefId: fixtureIds.positive });
    assert.deepEqual(mission.preferred.requirement, { label: "TABLE", minimumExtentM: [0.25, 0.18] });
    assert.deepEqual(mission.fallback.requirement, { label: "FLOOR", minimumExtentM: [0.8, 0.55] });
    assert.equal(mission.advisories[0].label, "WALL_ART");

    assert.throws(() => deriveFitRequest({ briefId: "../swanmissiontable" }), /briefId/i);
    assert.throws(() => deriveFitRequest({ briefId: missingBriefId }), /not found/i);
    assert.throws(() => deriveFitRequest({ briefId: fixtureIds.absentRoomExperience }), /roomExperience/i);
    assert.throws(() => deriveFitRequest({ briefId: fixtureIds.nonSwanRoomExperience }), /Invalid literal|AppSpec/i);
    assert.throws(() => deriveFitRequest({ briefId: fixtureIds.wrongStage }), /AppSpec|stage/i);
  });

  test("keeps explicit TABLE and FLOOR requirements simultaneous and X/Z ordered", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const simultaneous = deriveFitRequest({
      requirements: [
        { label: "TABLE", minimumExtentM: [0.5, 0.18] },
        { label: "FLOOR", minimumExtentM: [0.8, 0.55] },
      ],
    });
    const ranked = rankHomeEnvironments(dataset, simultaneous);
    assert.equal(ranked.status, "ranked");
    assert.ok(ranked.candidates.every((candidate) => candidate.fits.length === 2));
    assert.ok(ranked.candidates.every((candidate) => candidate.fits.map((fit) => fit.requirement.label).includes("TABLE")));
    assert.ok(ranked.candidates.every((candidate) => candidate.fits.map((fit) => fit.requirement.label).includes("FLOOR")));

    const ordered = rankHomeEnvironments(dataset, deriveFitRequest({
      requirements: [{ label: "TABLE", minimumExtentM: [0.5, 0.7] }],
    }));
    assert.deepEqual(ordered.candidates.map((candidate) => candidate.tile), ["Mesume Night"]);
    assert.throws(() => deriveFitRequest({ requirements: [{ label: "WALL_ART", minimumExtentM: [0.1, 0.1] }] }), /Invalid enum|unsupported/i);
  });

  test("ranks measured-potential mission TABLE fits with stable dataset-order ties", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const ranked = rankHomeEnvironments(dataset, deriveFitRequest({ briefId: fixtureIds.positive }));
    assert.equal(ranked.status, "ranked");
    assert.deepEqual(ranked.candidates.slice(0, 2).map((candidate) => candidate.tile), ["Livingroom Day", "Livingroom Night"]);
    assert.ok(ranked.candidates.slice(0, 2).every((candidate) => Math.abs(candidate.contentScale - 0.7739633333333333) < 1e-12));
    assert.ok(ranked.candidates.slice(0, 2).every((candidate) => candidate.tier === "preferred"));
    assert.ok(!ranked.candidates.some((entry) => entry.tile === "Mesume Day"));
  });

  test("ranks explicit requirements from measured potential even when every Day cluster is optional", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const explicit = rankHomeEnvironments(dataset, deriveFitRequest({
      requirements: [{ label: "TABLE", minimumExtentM: [0.7, 0.4] }],
    }));

    assert.equal(explicit.selectedTarget, "Livingroom Day");
    assert.deepEqual(explicit.candidates.slice(0, 2).map((candidate) => candidate.tile), ["Livingroom Day", "Livingroom Night"]);
    assert.deepEqual(explicit.candidates.find((candidate) => candidate.tile === "Livingroom Day").fits[0].surfaceExtentM, [0.782631, 0.464378]);
    assert.deepEqual(dataset.environments.find((entry) => entry.tile === "Livingroom Day").guaranteedSurfaces, { FLOOR: [], TABLE: [] });
  });

  test("ranks every refreshed FLOOR and TABLE cluster as measured potential", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const explicit = rankHomeEnvironments(dataset, deriveFitRequest({
      requirements: [
        { label: "FLOOR", minimumExtentM: [6, 4] },
        { label: "TABLE", minimumExtentM: [0.7, 0.4] },
      ],
    }));

    assert.equal(explicit.status, "ranked");
    assert.deepEqual(
      explicit.candidates.slice(0, 2).map((candidate) => candidate.tile),
      ["Livingroom Day", "Livingroom Night"],
    );
    for (const candidate of explicit.candidates.slice(0, 2)) {
      assert.deepEqual(candidate.fits.map((fit) => fit.surfaceExtentM), [
        [6.867676, 4.439027],
        [0.782631, 0.464378],
      ]);
    }
  });

  test("refreshed surfaces and extent-cluster representatives must match one-to-one", async (t) => {
    const source = loadPackagedHomeEnvironmentDataset();
    for (const [name, mutate] of [
      ["missing surface representative", (day) => { day.surfaces.TABLE.pop(); }],
      ["extra surface representative", (day) => { day.surfaces.TABLE.push([1, 0.2, 1]); }],
      ["duplicate surface representative", (day) => { day.surfaces.TABLE.push(structuredClone(day.surfaces.TABLE[0])); }],
      ["duplicate cluster representative", (day) => { day.extentClusters.TABLE.push(structuredClone(day.extentClusters.TABLE[0])); }],
      ["Cartesian-swapped surface representative", (day) => {
        day.surfaces.FLOOR[0] = [day.surfaces.FLOOR[0][0], day.surfaces.FLOOR[1][1], day.surfaces.FLOOR[1][2]];
      }],
    ]) {
      await t.test(name, () => {
        const changed = structuredClone(source);
        mutate(changed.environments.find((entry) => entry.tile === "Livingroom Night"));
        assert.equal(homeEnvironmentDatasetSchema.safeParse(changed).success, false);
      });
    }
  });

  test("guaranteed surfaces exactly project the duplicate-free clusters whose minimum presence is positive", async (t) => {
    const source = loadPackagedHomeEnvironmentDataset();
    for (const [name, mutate] of [
      ["missing required guarantee", (night) => { night.guaranteedSurfaces.FLOOR.pop(); }],
      ["extra optional guarantee", (night) => {
        night.guaranteedSurfaces.TABLE.push(structuredClone(night.extentClusters.TABLE[1].extentM));
      }],
      ["duplicate required guarantee", (night) => {
        night.guaranteedSurfaces.FLOOR.push(structuredClone(night.guaranteedSurfaces.FLOOR[0]));
      }],
      ["Cartesian-swapped guarantee", (night) => {
        night.guaranteedSurfaces.FLOOR[0] = [
          night.extentClusters.FLOOR[0].extentM[0],
          night.extentClusters.FLOOR[1].extentM[1],
          night.extentClusters.FLOOR[1].extentM[2],
        ];
      }],
    ]) {
      await t.test(name, () => {
        const changed = structuredClone(source);
        mutate(changed.environments.find((entry) => entry.tile === "Livingroom Night"));
        assert.equal(homeEnvironmentDatasetSchema.safeParse(changed).success, false);
      });
    }
  });

  test("uses FLOOR only when no mission TABLE candidate fits", () => {
    const dataset = withoutRefreshExtensions(loadPackagedHomeEnvironmentDataset());
    for (const environment of dataset.environments) {
      environment.surfaces.TABLE = [];
    }

    const ranked = rankHomeEnvironments(dataset, deriveFitRequest({ briefId: fixtureIds.positive }));
    assert.equal(ranked.status, "ranked");
    assert.equal(ranked.candidates[0].tier, "fallback");
    assert.equal(ranked.candidates[0].tile, "Mesume Night");
    assert.equal(ranked.candidates[0].contentScale, null);
  });

  test("orders explicit equal-minimum fits by descending fit-ratio sum", () => {
    const dataset = structuredClone(loadPackagedHomeEnvironmentDataset());
    delete dataset.measurement.refreshProvenance;
    for (const environment of dataset.environments.slice(2)) {
      environment.automaticSelectionEligible = false;
      environment.measurementStatus = "invalid_payload";
      environment.exclusionReason = "synthetic ordering fixture";
      delete environment.guaranteedSurfaces;
      delete environment.extentClusters;
    }
    dataset.environments[0].surfaces = { TABLE: [[1, 0, 1]], FLOOR: [[1, 0, 1]] };
    dataset.environments[1].surfaces = { TABLE: [[1, 0, 1]], FLOOR: [[3, 0, 2]] };

    const ranked = rankHomeEnvironments(dataset, deriveFitRequest({
      requirements: [
        { label: "TABLE", minimumExtentM: [1, 1] },
        { label: "FLOOR", minimumExtentM: [1, 1] },
      ],
    }));
    assert.deepEqual(ranked.candidates.map((candidate) => candidate.tile), ["Bedroom Night", "Bedroom Day"]);
    assert.deepEqual(ranked.candidates.map((candidate) => [candidate.minimumFitRatio, candidate.sumFitRatios]), [[1, 3], [1, 2]]);
  });

  test("returns no_fit when no eligible surface satisfies every requirement", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const ranked = rankHomeEnvironments(dataset, deriveFitRequest({
      requirements: [{ label: "TABLE", minimumExtentM: [9, 9] }],
    }));
    assert.equal(ranked.status, "no_fit");
    assert.deepEqual(ranked.candidates, []);
    assert.equal(ranked.selectedTarget, null);
  });

  test("classifies the CP1 Livingroom Day query from its complete mesh fingerprint", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const classified = classifyObservedHomeEnvironment(dataset, livingroomDayQuery, classificationRequirements);

    assert.equal(classified.status, "unique");
    assert.equal(classified.environment.tile, "Livingroom Day");
    assert.deepEqual(classified.histogramMatches, ["Livingroom Day"]);
  });

  test("uniquely accepts all five Day and both Night refreshed histogram/cluster observations", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    for (const [tile, queries] of [
      ["Livingroom Day", livingroomDayQueries],
      ["Livingroom Night", livingroomNightQueries],
    ]) {
      for (const query of queries) {
        const classified = classifyObservedHomeEnvironment(dataset, query, allFixtureRequirements);
        assert.equal(classified.status, "unique", `${tile} ${query.snapshotId}`);
        assert.equal(classified.environment.tile, tile, `${tile} ${query.snapshotId}`);
        assert.deepEqual(classified.histogramMatches, [tile], `${tile} ${query.snapshotId}`);
        assert.equal(classified.predicates.surfaceExtentMultisetsMatch, true, `${tile} ${query.snapshotId}`);
      }
    }
  });

  test("requires the globally ranked mission tier live after identity and cluster checks", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const mission = deriveFitRequest({ briefId: fixtureIds.positive });
    const refresh4 = livingroomDayQueries.at(-1);
    const floorOnlyFit = classifyObservedHomeEnvironment(dataset, refresh4, mission);

    assert.equal(rankHomeEnvironments(dataset, mission).candidates[0].tier, "preferred");
    assert.equal(floorOnlyFit.status, "extent_mismatch");
    assert.deepEqual(floorOnlyFit.histogramMatches, ["Livingroom Day"]);
    assert.equal(floorOnlyFit.predicates.surfaceExtentMultisetsMatch, true);
    assert.equal(floorOnlyFit.predicates.requirementsFit, false);

    const preferredLive = structuredClone(refresh4);
    const largeTable = structuredClone(livingroomDayQuery.anchors.find((anchor) =>
      anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7,
    ));
    assert.ok(largeTable, "accepted calibration read must contain the preferred TABLE cluster");
    largeTable.traceId = "anchor-9997";
    largeTable.runtimeUuid = `${largeTable.runtimeUuid}-preferred-live`;
    preferredLive.anchors.push(largeTable);
    preferredLive.histogram.TABLE += 1;
    preferredLive.totalAnchorCount += 1;
    preferredLive.matchedAnchorCount = preferredLive.anchors.length;
    const preferredFit = classifyObservedHomeEnvironment(dataset, preferredLive, mission);
    assert.equal(preferredFit.status, "unique");
    assert.equal(preferredFit.environment.tile, "Livingroom Day");
    assert.equal(preferredFit.predicates.requirementsFit, true);

    const fallbackMission = structuredClone(mission);
    fallbackMission.preferred.requirement.minimumExtentM = [9, 9];
    assert.equal(rankHomeEnvironments(dataset, fallbackMission).candidates[0].tier, "fallback");
    const fallbackFit = classifyObservedHomeEnvironment(dataset, refresh4, fallbackMission);
    assert.equal(fallbackFit.status, "unique");
    assert.equal(fallbackFit.predicates.requirementsFit, true);
  });

  test("keeps explicit TABLE and FLOOR requirements simultaneous for a cluster-compatible observation", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const classified = classifyObservedHomeEnvironment(dataset, livingroomDayQueries.at(-1), classificationRequirements);

    assert.equal(classified.status, "extent_mismatch");
    assert.equal(classified.predicates.surfaceExtentMultisetsMatch, true);
    assert.equal(classified.predicates.requirementsFit, false);
  });

  test("fails closed before candidate-specific cluster or mission-tier fit when two histograms overlap", () => {
    const overlapDataset = structuredClone(loadPackagedHomeEnvironmentDataset());
    const livingroomDay = overlapDataset.environments.find((entry) => entry.tile === "Livingroom Day");
    const syntheticOverlap = overlapDataset.environments.find((entry) => entry.tile === "Livingroom Night");
    syntheticOverlap.totalAnchorCountRange = structuredClone(livingroomDay.totalAnchorCountRange);
    syntheticOverlap.histogramRanges = structuredClone(livingroomDay.histogramRanges);
    syntheticOverlap.surfaces = {
      FLOOR: structuredClone(livingroomDay.surfaces.FLOOR),
      TABLE: [[0.176013, 0.174682, 0.176883]],
    };
    syntheticOverlap.guaranteedSurfaces = {
      FLOOR: [],
      TABLE: [[0.176013, 0.174682, 0.176883]],
    };
    syntheticOverlap.extentClusters = {
      FLOOR: structuredClone(livingroomDay.extentClusters.FLOOR),
      TABLE: [{ extentM: [0.176013, 0.174682, 0.176883], presenceCountRange: [1, 1] }],
    };
    const mission = deriveFitRequest({ briefId: fixtureIds.positive });
    const ranked = rankHomeEnvironments(overlapDataset, mission);

    assert.equal(ranked.candidates.some((candidate) => candidate.tile === "Livingroom Day"), true);
    assert.equal(ranked.candidates.some((candidate) => candidate.tile === "Livingroom Night"), false);
    const classified = classifyObservedHomeEnvironment(overlapDataset, livingroomDayQuery, mission);
    assert.equal(classified.status, "ambiguous");
    assert.equal(classified.environment, null);
    assert.deepEqual(classified.histogramMatches, ["Livingroom Day", "Livingroom Night"]);
    assert.equal(classified.predicates.surfaceExtentMultisetsMatch, null);
    assert.equal(classified.predicates.requirementsFit, null);
  });

  test("rejects every terminal bridge status before attempting classification", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    for (const status of ["label_absent", "not_ready", "stage_not_open", "bridge_unavailable", "stage_mismatch", "invalid_payload", "binding_failed"]) {
      const query = terminalQuery(status);
      assert.equal(query.error.code, status, status);
      assert.equal(query.snapshotId, null, status);
      assert.deepEqual(query.anchors, [], status);
      assert.equal(query.drift.withinPolicy, false, status);
      assert.deepEqual(query.drift.deltas, [], status);
      assert.deepEqual(query.actionReceipts, [], status);
      const classified = classifyObservedHomeEnvironment(dataset, query, classificationRequirements);
      assert.equal(classified.status, "terminal_status", status);
      assert.equal(classified.environment, null, status);
      assert.equal(classified.predicates.bridgeStatus, status, status);
    }
  });

  test("rejects zero matches for extra labels, zero-valued missing labels, and raw totals outside observed ranges", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const extraLabel = withLivingroomDayQuery((query) => { query.histogram.UNRELATED = 1; });
    const missingLabel = withLivingroomDayQuery((query) => { delete query.histogram.DOOR; });
    const outsideTotal = withLivingroomDayQuery((query) => { query.totalAnchorCount = 61; });
    const rawTotalOutsideWithAdvisoryWallArt = withLivingroomDayQuery((query) => {
      query.totalAnchorCount = 61;
      query.histogram.WALL_ART = 2;
    });

    for (const query of [extraLabel, missingLabel, outsideTotal, rawTotalOutsideWithAdvisoryWallArt]) {
      const classified = classifyObservedHomeEnvironment(dataset, query, classificationRequirements);
      assert.equal(classified.status, "no_match");
      assert.equal(classified.environment, null);
      assert.deepEqual(classified.histogramMatches, []);
    }
  });

  test("accepts a missing label as zero when the candidate explicitly measures zero", () => {
    const zeroRangeDataset = structuredClone(loadPackagedHomeEnvironmentDataset());
    zeroRangeDataset.environments.find((entry) => entry.tile === "Livingroom Day").histogramRanges.CHAIR = [0, 0];
    const missingZeroLabel = withLivingroomDayQuery((query) => { delete query.histogram.CHAIR; });

    const classified = classifyObservedHomeEnvironment(zeroRangeDataset, missingZeroLabel, classificationRequirements);
    assert.equal(classified.status, "unique");
    assert.equal(classified.environment.tile, "Livingroom Day");
    assert.deepEqual(classified.histogramMatches, ["Livingroom Day"]);
  });

  test("requires the live query to cover measured FLOOR and TABLE labels", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const classified = classifyObservedHomeEnvironment(dataset, withLivingroomDayQuery((query) => {
      query.requestedLabels = ["TABLE"];
    }), classificationRequirements);

    assert.equal(classified.status, "incomplete_requested_labels");
    assert.equal(classified.environment, null);
    assert.deepEqual(classified.histogramMatches, ["Livingroom Day"]);
    assert.deepEqual(classified.predicates.missingRequestedLabels, ["FLOOR"]);
  });

  test("rejects a unique histogram when its FLOOR or TABLE extents no longer match or fit", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const multisetMismatch = classifyObservedHomeEnvironment(dataset, withLivingroomDayQuery((query) => {
      query.anchors.find((anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7).boundsM[0] += 0.02;
    }), classificationRequirements);
    const requirementMismatch = classifyObservedHomeEnvironment(dataset, livingroomDayQuery, deriveFitRequest({
      requirements: [{ label: "TABLE", minimumExtentM: [1, 1] }],
    }));

    assert.equal(multisetMismatch.status, "extent_mismatch");
    assert.equal(multisetMismatch.environment, null);
    assert.deepEqual(multisetMismatch.histogramMatches, ["Livingroom Day"]);
    assert.equal(multisetMismatch.predicates.surfaceExtentMultisetsMatch, false);
    assert.equal(multisetMismatch.predicates.requirementsFit, null);
    assert.equal(requirementMismatch.status, "extent_mismatch");
    assert.equal(requirementMismatch.predicates.surfaceExtentMultisetsMatch, true);
    assert.equal(requirementMismatch.predicates.requirementsFit, false);
  });

  test("enforces closed cluster cardinalities and X/Y/Z tolerance after unique identity", async (t) => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const cases = [
      ["unknown third anchor", (query) => {
        const source = structuredClone(query.anchors.find((anchor) => anchor.labels.includes("TABLE")));
        source.traceId = "anchor-9998";
        source.runtimeUuid = `${source.runtimeUuid}-unknown`;
        source.boundsM = [0.4, 0.2, 0.4];
        query.anchors.push(source);
        query.matchedAnchorCount = query.anchors.length;
      }],
      ["duplicate beyond maximum", (query) => duplicateAnchor(
        query,
        (anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7,
      )],
      ["X outside tolerance", (query) => {
        query.anchors.find((anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7).boundsM[0] = 0.792632;
      }],
      ["Y outside tolerance", (query) => {
        query.anchors.find((anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7).boundsM[1] = 0.198128;
      }],
      ["Z outside tolerance", (query) => {
        query.anchors.find((anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7).boundsM[2] = 0.474379;
      }],
    ];

    for (const [name, mutate] of cases) {
      await t.test(name, () => {
        const classified = classifyObservedHomeEnvironment(dataset, withLivingroomDayQuery(mutate), classificationRequirements);
        assert.equal(classified.status, "extent_mismatch");
        assert.deepEqual(classified.histogramMatches, ["Livingroom Day"]);
        assert.equal(classified.predicates.surfaceExtentMultisetsMatch, false);
        assert.equal(classified.predicates.requirementsFit, null);
      });
    }
  });

  test("rejects the next representable value outside either X/Y/Z tolerance endpoint", async (t) => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const representative = [0.782631, 0.188127, 0.464378];
    const cases = representative.flatMap((measured, component) => [
      [`${["X", "Y", "Z"][component]} above upper endpoint`, component, nextUp(measured + 0.01)],
      [`${["X", "Y", "Z"][component]} below lower endpoint`, component, nextDown(measured - 0.01)],
    ]);

    for (const [name, component, observed] of cases) {
      await t.test(name, () => {
        const outside = withLivingroomDayQuery((query) => {
          const largeTable = query.anchors.find((anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7);
          largeTable.boundsM[component] = observed;
        });
        const classified = classifyObservedHomeEnvironment(dataset, outside, classificationRequirements);

        assert.equal(classified.status, "extent_mismatch");
        assert.deepEqual(classified.histogramMatches, ["Livingroom Day"]);
        assert.equal(classified.predicates.surfaceExtentMultisetsMatch, false);
        assert.equal(classified.predicates.requirementsFit, null);
      });
    }
  });

  test("accepts cluster permutations and equality at both X/Y/Z tolerance endpoints", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const representative = [0.782631, 0.188127, 0.464378];
    for (const direction of [-1, 1]) {
      const boundary = withLivingroomDayQuery((query) => {
        const largeTable = query.anchors.find((anchor) => anchor.labels.includes("TABLE") && anchor.boundsM[0] > 0.7);
        largeTable.boundsM = representative.map((measured) => measured + direction * 0.01);
        query.anchors.reverse();
      });
      const classified = classifyObservedHomeEnvironment(dataset, boundary, classificationRequirements);

      assert.equal(classified.status, "unique");
      assert.equal(classified.environment.tile, "Livingroom Day");
      assert.equal(classified.predicates.surfaceExtentMultisetsMatch, true);
    }
  });

  test("rejects an anchor that falls within more than one synthetic cluster", () => {
    const dataset = structuredClone(loadPackagedHomeEnvironmentDataset());
    const day = dataset.environments.find((entry) => entry.tile === "Livingroom Day");
    assert.ok(day.extentClusters, "packaged Livingroom Day must expose clusters");
    day.extentClusters.TABLE.push({
      extentM: [0.787631, 0.188127, 0.464378],
      presenceCountRange: [0, 1],
    });
    day.surfaces.TABLE.push([0.787631, 0.188127, 0.464378]);

    const classified = classifyObservedHomeEnvironment(dataset, livingroomDayQuery, classificationRequirements);
    assert.equal(classified.status, "extent_mismatch");
    assert.equal(classified.predicates.surfaceExtentMultisetsMatch, false);
    assert.equal(classified.predicates.requirementsFit, null);
  });

  test("excludes invalid Mesume Day and keeps WALL_ART advisory to identity", () => {
    const dataset = loadPackagedHomeEnvironmentDataset();
    const mesumeDay = dataset.environments.find((entry) => entry.tile === "Mesume Day");
    const mesumeDayQuery = withLivingroomDayQuery((query) => {
      query.totalAnchorCount = mesumeDay.totalAnchorCountRange[0];
      query.histogram = measuredHistogram(mesumeDay);
    });
    const wallArtChanged = withLivingroomDayQuery((query) => {
      query.histogram.WALL_ART = 2;
    });

    const excluded = classifyObservedHomeEnvironment(dataset, mesumeDayQuery, classificationRequirements);
    assert.equal(excluded.status, "no_match");
    assert.deepEqual(excluded.histogramMatches, []);

    const advisory = classifyObservedHomeEnvironment(dataset, wallArtChanged, classificationRequirements);
    assert.equal(advisory.status, "unique");
    assert.equal(advisory.environment.tile, "Livingroom Day");
  });
} finally {
  if (!cleanupRegistered) {
    for (const id of Object.values(fixtureIds)) fs.rmSync(path.join(userBriefs, `${id}.json`), { force: true });
  }
}
