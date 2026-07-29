using UnityEngine;

/// The unmistakable hello scene, constructed at runtime (no scene-file authoring, no GUID
/// plumbing): lit magenta cube / yellow sphere / green capsule over a white floor on a cyan
/// clear. Registers the bridge commands the E2E drives: color:<red|green|blue|...> (any HTML
/// color string), spin:<on|off>.
public sealed class HelloSpatialRuntime : MonoBehaviour
{
    /// Assigned by PicoBuild in the generated scene. The material ASSET references Unlit/Color,
    /// which is what actually ships the shader in the build — without a built asset reference,
    /// Unity strips it and every primitive renders Hidden/InternalErrorShader magenta (found by
    /// LOOKing at the first E2E capture, 2026-07-28).
    public Material unlitMaterial;

    private GameObject _cube;
    private bool _spin = true;

    private void Start()
    {
        Light sun = new GameObject("Sun").AddComponent<Light>();
        sun.type = LightType.Directional;
        sun.transform.rotation = Quaternion.Euler(50f, -30f, 0f);

        GameObject floor = GameObject.CreatePrimitive(PrimitiveType.Plane);
        floor.name = "Floor";
        Tint(floor, Color.white);

        _cube = Place(PrimitiveType.Cube, "HelloCube", new Vector3(-1.4f, 1f, 0f), Color.magenta);
        Place(PrimitiveType.Sphere, "HelloSphere", new Vector3(0f, 1f, 0f), Color.yellow);
        Place(PrimitiveType.Capsule, "HelloCapsule", new Vector3(1.4f, 1f, 0f), Color.green);

        PicoAgentBridge.Commands["color"] = (arg) =>
        {
            Color parsed;
            if (ColorUtility.TryParseHtmlString(arg, out parsed)) Tint(_cube, parsed);
            else Debug.LogWarning("PICOAGENT| bad color " + arg);
        };
        PicoAgentBridge.Commands["spin"] = (arg) => { _spin = arg != "off"; };
        Debug.Log("PICOAGENT| scene_ready windowed cube+sphere+capsule");
    }

    private void Update()
    {
        if (_spin && _cube != null) _cube.transform.Rotate(0f, 40f * Time.deltaTime, 0f);
    }

    private GameObject Place(PrimitiveType type, string name, Vector3 position, Color color)
    {
        GameObject go = GameObject.CreatePrimitive(type);
        go.name = name;
        go.transform.position = position;
        Tint(go, color);
        return go;
    }

    private void Tint(GameObject go, Color color)
    {
        Material m = unlitMaterial != null ? new Material(unlitMaterial) : new Material(Shader.Find("Unlit/Color"));
        m.color = color;
        go.GetComponent<Renderer>().sharedMaterial = m;
    }
}
