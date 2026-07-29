using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

/// Batchmode entrypoint for pico-spatial-mcp's unity_build_apk:
///   Unity -batchmode -quit -projectPath <p> -executeMethod PicoBuild.Apk -buildTarget android -logFile <log>
/// Reads Assets/PicoAgent/picoagent-config.json, applies ALL player settings programmatically
/// (the hello-XR-proven pattern — no ProjectSettings.asset ships in the skeleton), generates the
/// scene from code, builds Builds/app.apk, and writes Builds/build-result.json. The JSON file is
/// the tool's contract; log text is for humans.
public static class PicoBuild
{
    [Serializable]
    private class Config
    {
        public string packageName;
        public string productName;
        public bool immersive;
        public string[] extraDefines;
    }

    [Serializable]
    private class Result
    {
        public bool ok;
        public string apkPath;
        public string unityVersion;
        public double durationSec;
        public string error;
    }

    public static void Apk()
    {
        DateTime started = DateTime.UtcNow;
        Result result = new Result { ok = false, unityVersion = Application.unityVersion };
        try
        {
            Config config = JsonUtility.FromJson<Config>(
                File.ReadAllText("Assets/PicoAgent/picoagent-config.json"));
            ConfigureAndroid(config);
            if (config.immersive) ConfigureImmersiveViaReflection();
            string scenePath = CreateScene();

            Directory.CreateDirectory("Builds");
            BuildReport report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { scenePath },
                locationPathName = "Builds/app.apk",
                target = BuildTarget.Android,
                targetGroup = BuildTargetGroup.Android,
                options = BuildOptions.Development,
            });
            if (report.summary.result != BuildResult.Succeeded)
            {
                throw new InvalidOperationException(
                    "Unity player build failed: " + report.summary.result
                    + " errors=" + report.summary.totalErrors);
            }

            result.ok = true;
            result.apkPath = Path.GetFullPath("Builds/app.apk");
            Debug.Log("PICOAGENT_BUILD_OK apk=" + result.apkPath + " package=" + config.packageName);
        }
        catch (Exception e)
        {
            result.error = e.Message;
            Debug.LogException(e);
        }
        finally
        {
            result.durationSec = (DateTime.UtcNow - started).TotalSeconds;
            Directory.CreateDirectory("Builds");
            File.WriteAllText("Builds/build-result.json", JsonUtility.ToJson(result, true));
            if (!result.ok) EditorApplication.Exit(1);
        }
    }

    private static void ConfigureAndroid(Config config)
    {
        if (!EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android))
        {
            throw new InvalidOperationException("Could not switch Unity to the Android build target.");
        }

        NamedBuildTarget android = NamedBuildTarget.Android;
        PlayerSettings.companyName = "pico-spatial-mcp";
        PlayerSettings.productName = config.productName;
        PlayerSettings.bundleVersion = "1.0.0";
        PlayerSettings.SetApplicationIdentifier(android, config.packageName);
        PlayerSettings.SetScriptingBackend(android, ScriptingImplementation.IL2CPP);
        PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
        PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel29;
        PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevelAuto;
        PlayerSettings.Android.applicationEntry = AndroidApplicationEntry.Activity;
        PlayerSettings.defaultInterfaceOrientation = UIOrientation.LandscapeLeft;
        PlayerSettings.colorSpace = ColorSpace.Linear;
        PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
        PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.Vulkan });

        if (config.extraDefines != null && config.extraDefines.Length > 0)
        {
            string existing = PlayerSettings.GetScriptingDefineSymbols(android);
            var all = new List<string>(existing.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries));
            foreach (string define in config.extraDefines)
            {
                if (!all.Contains(define)) all.Add(define);
            }
            PlayerSettings.SetScriptingDefineSymbols(android, string.Join(";", all));
        }
    }

    /// Immersive scaffolds ship Assets/Editor/PicoXrSetup.cs (XR packages present); windowed
    /// scaffolds don't, and this file must still compile there — hence reflection, not a using.
    private static void ConfigureImmersiveViaReflection()
    {
        Type setup = Type.GetType("PicoXrSetup, Assembly-CSharp-Editor");
        if (setup == null)
        {
            throw new InvalidOperationException(
                "immersive=true but PicoXrSetup is absent — re-scaffold with immersive: true.");
        }
        setup.GetMethod("Configure").Invoke(null, null);
    }

    private static string CreateScene()
    {
        Directory.CreateDirectory("Assets/Scenes");
        AssetDatabase.Refresh();
        Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        Camera camera = new GameObject("Main Camera").AddComponent<Camera>();
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = new Color(0f, 0.8f, 0.9f); // cyan — unmistakable in a capture
        camera.transform.position = new Vector3(0f, 1f, -4f);
        GameObject root = new GameObject("PicoAgentRoot");
        root.AddComponent<HelloSpatialRuntime>();
        root.AddComponent<PicoAgentBridge>();
        const string scenePath = "Assets/Scenes/HelloSpatial.unity";
        EditorSceneManager.SaveScene(scene, scenePath);
        return scenePath;
    }
}
