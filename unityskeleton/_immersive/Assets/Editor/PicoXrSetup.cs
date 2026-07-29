using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Unity.XR.OpenXR.Features.PICOSupport;
using UnityEditor;
using UnityEditor.XR.Management;
using UnityEditor.XR.OpenXR.Features;
using UnityEngine;
using UnityEngine.XR.Management;
using UnityEngine.XR.OpenXR;
using UnityEngine.XR.OpenXR.Features;
using UnityEngine.XR.OpenXR.Features.Interactions;

/// Immersive-mode OpenXR configuration — the ConfigureOpenXr()/FindOrCreateGeneralSettings()
/// bodies proven by the 2026-07-22 hello-XR settling test, unchanged. This file ships ONLY in
/// immersive scaffolds (unityskeleton/_immersive overlay), so windowed scaffolds never compile
/// XR types; PicoBuild.Apk reaches it via reflection when picoagent-config.json says
/// immersive=true. On emulator 0.13.x the session runs and submits layers but pixels do not
/// composite (structural ceiling) — do not read a black capture as a visual success.
public static class PicoXrSetup
{
    public static void Configure()
    {
        ConfigureOpenXr();
    }

    private static void ConfigureOpenXr()
    {
        Directory.CreateDirectory("Assets/XR/Loaders");
        AssetDatabase.Refresh();

        XRGeneralSettingsPerBuildTarget general = FindOrCreateGeneralSettings();
        if (!general.HasManagerSettingsForBuildTarget(BuildTargetGroup.Android))
        {
            general.CreateDefaultManagerSettingsForBuildTarget(BuildTargetGroup.Android);
        }

        XRGeneralSettings androidGeneral = general.SettingsForBuildTarget(BuildTargetGroup.Android);
        androidGeneral.InitManagerOnStart = true;
        XRManagerSettings manager = androidGeneral.Manager;

        const string loaderPath = "Assets/XR/Loaders/OpenXRLoader.asset";
        OpenXRLoader loader = AssetDatabase.LoadAssetAtPath<OpenXRLoader>(loaderPath);
        if (loader == null)
        {
            loader = ScriptableObject.CreateInstance<OpenXRLoader>();
            loader.name = "OpenXRLoader";
            AssetDatabase.CreateAsset(loader, loaderPath);
        }

        if (!manager.TrySetLoaders(new List<XRLoader> { loader }))
        {
            throw new InvalidOperationException("Could not assign the sole Android OpenXR loader.");
        }

        FeatureHelpers.RefreshFeatures(BuildTargetGroup.Android);
        string[] requiredFeatureIds =
        {
            PICOFeature.featureId,
            OpenXRExtensions.featureId,
            PICO4ControllerProfile.featureId
        };

        OpenXRSettings openXr = OpenXRSettings.GetSettingsForBuildTargetGroup(BuildTargetGroup.Android);
        if (openXr == null)
        {
            throw new InvalidOperationException("Android OpenXR settings were not created.");
        }

        var required = new HashSet<OpenXRFeature>();
        foreach (string featureId in requiredFeatureIds)
        {
            OpenXRFeature feature = FeatureHelpers.GetFeatureWithIdForBuildTarget(
                BuildTargetGroup.Android,
                featureId);
            if (feature == null)
            {
                throw new InvalidOperationException("Missing required OpenXR feature: " + featureId);
            }

            feature.enabled = true;
            required.Add(feature);
            EditorUtility.SetDirty(feature);
        }

        foreach (OpenXRFeature feature in openXr.GetFeatures())
        {
            if (feature != null && !required.Contains(feature) && feature.hideFlags == HideFlags.None)
            {
                feature.enabled = false;
                EditorUtility.SetDirty(feature);
            }
        }

        openXr.renderMode = OpenXRSettings.RenderMode.SinglePassInstanced;
        openXr.depthSubmissionMode = OpenXRSettings.DepthSubmissionMode.None;
        PICOProjectSetting.GetProjectConfig();

        EditorUtility.SetDirty(general);
        EditorUtility.SetDirty(androidGeneral);
        EditorUtility.SetDirty(manager);
        EditorUtility.SetDirty(openXr);
        AssetDatabase.SaveAssets();

        Debug.Log(
            "PICOAGENT_XR_CONFIG loader=" + loader.GetType().FullName
            + " features=" + string.Join(",", requiredFeatureIds)
            + " graphics=" + string.Join(",", PlayerSettings.GetGraphicsAPIs(BuildTarget.Android).Select(x => x.ToString()))
            + " architecture=" + PlayerSettings.Android.targetArchitectures);
    }

    private static XRGeneralSettingsPerBuildTarget FindOrCreateGeneralSettings()
    {
        XRGeneralSettingsPerBuildTarget general = AssetDatabase.FindAssets("t:XRGeneralSettingsPerBuildTarget")
            .Select(AssetDatabase.GUIDToAssetPath)
            .Select(path => AssetDatabase.LoadAssetAtPath<XRGeneralSettingsPerBuildTarget>(path))
            .FirstOrDefault(asset => asset != null);

        if (general == null)
        {
            Directory.CreateDirectory("Assets/XR");
            AssetDatabase.Refresh();
            general = ScriptableObject.CreateInstance<XRGeneralSettingsPerBuildTarget>();
            general.name = "XRGeneralSettingsPerBuildTarget";
            AssetDatabase.CreateAsset(general, "Assets/XR/XRGeneralSettingsPerBuildTarget.asset");
        }

        EditorBuildSettings.AddConfigObject(XRGeneralSettings.k_SettingsKey, general, true);
        return general;
    }
}
