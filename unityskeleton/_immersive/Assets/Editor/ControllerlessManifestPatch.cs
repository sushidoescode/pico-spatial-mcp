using System.IO;
using System.Text;
using System.Xml;
using UnityEditor.Android;
using UnityEngine;

/// Verbatim from the 2026-07-22 hello-XR settling test: the PICO OpenXR package unconditionally
/// emits controller=1 manifest metadata, which makes the emulator show a "Controllers Required"
/// prompt before a controllerless scene can start. This post-build callback removes it — and
/// refuses to run silently if the metadata shape ever changes. Ships only in immersive scaffolds.
public sealed class ControllerlessManifestPatch : IPostGenerateGradleAndroidProject
{
    private const string AndroidNamespace = "http://schemas.android.com/apk/res/android";

    public int callbackOrder => 100;

    public void OnPostGenerateGradleAndroidProject(string basePath)
    {
        string manifestPath = Path.Combine(basePath, "src", "main", "AndroidManifest.xml");
        var document = new XmlDocument();
        document.Load(manifestPath);

        var namespaces = new XmlNamespaceManager(document.NameTable);
        namespaces.AddNamespace("android", AndroidNamespace);
        XmlNode controller = document.SelectSingleNode(
            "/manifest/application/meta-data[@android:name='controller']",
            namespaces);
        if (controller == null)
        {
            throw new InvalidDataException(
                "PICO OpenXR did not emit the expected controller metadata; refusing a silent patch.");
        }

        controller.ParentNode.RemoveChild(controller);
        using (var writer = new XmlTextWriter(manifestPath, new UTF8Encoding(false)))
        {
            writer.Formatting = Formatting.Indented;
            document.Save(writer);
        }

        Debug.Log("PICOAGENT_MANIFEST controller_requirement=removed scene_requires_input=false");
    }
}
