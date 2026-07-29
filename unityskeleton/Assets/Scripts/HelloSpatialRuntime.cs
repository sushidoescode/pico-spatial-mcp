using UnityEngine;

/// The unmistakable hello scene, constructed at runtime (no scene-file authoring, no GUID
/// plumbing): lit magenta cube / yellow sphere / green capsule over a white floor on a cyan
/// clear. Registers the bridge commands the E2E drives: color:<red|green|blue|...> (any HTML
/// color string), spin:<on|off>.
public sealed class HelloSpatialRuntime : MonoBehaviour
{
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

    private static GameObject Place(PrimitiveType type, string name, Vector3 position, Color color)
    {
        GameObject go = GameObject.CreatePrimitive(type);
        go.name = name;
        go.transform.position = position;
        Tint(go, color);
        return go;
    }

    private static void Tint(GameObject go, Color color)
    {
        go.GetComponent<Renderer>().material.color = color;
    }
}
