def diagnostic_labels:
  (.semanticAssignments | unique) as $labels
  | if ($labels | length) == 0 then ["<empty>"] else $labels end;

def label_histogram:
  reduce (.anchors[] | diagnostic_labels[]) as $label
    ({}; .[$label] = ((.[$label] // 0) + 1));

def relevant_surfaces:
  [.anchors
   | to_entries[]
   | . as $entry
   | ($entry.value.semanticAssignments | unique) as $labels
   | select((($labels | index("FLOOR")) != null) or (($labels | index("TABLE")) != null))
   | {
       sourceIndex: $entry.key,
       runtimeUuid: $entry.value.runtimeUuid,
       labels: $labels,
       positionM: $entry.value.positionM,
       boundsM: $entry.value.boundsM,
       vertexCount: ($entry.value.vertices | length),
       indexCount: ($entry.value.indices | length)
     }];

def invalid_anchors:
  [.anchors
   | to_entries[]
   | select(((.value.vertices | length) == 0) or ((.value.indices | length) == 0))
   | {
       sourceIndex: .key,
       runtimeUuid: .value.runtimeUuid,
       labels: (.value.semanticAssignments | unique),
       positionM: .value.positionM,
       boundsM: .value.boundsM,
       vertexCount: (.value.vertices | length),
       indexCount: (.value.indices | length)
     }];

{
  extractionSchemaVersion: 1,
  source: {
    sha256: $sourceSha,
    bytes: $sourceBytes,
    command: "jq --sort-keys --arg sourceSha 09553b9525b67e5e7bbc56fa063406a9a7f0b4c2df3975b0233a4a4c1117f797 --argjson sourceBytes 10464752 -f mesume-day-diagnostic-extract.jq mesume-day-raw-bridge.json"
  },
  bridge: {
    kind: .kind,
    schemaVersion: .schemaVersion,
    bridgeRevision: .bridgeRevision,
    requestId: .requestId,
    coordinateFrame: .coordinateFrame,
    readiness: .readiness,
    application: .application
  },
  nonEmptyReads:
    [.reads[]
     | select(.anchorCount > 0)
     | . as $read
     | {
         readIndex: $read.readIndex,
         queriedAtMonotonicNs: $read.queriedAtMonotonicNs,
         trackingState: $read.trackingState,
         anchorCount: $read.anchorCount,
         histogram: ($read | label_histogram),
         relevantSurfaces: ($read | relevant_surfaces),
         invalidAnchors: ($read | invalid_anchors)
       }]
}
