using System;
using System.Collections.Generic;
using UnityEngine;

/// pico-spatial-mcp drive contract: the app answers <applicationId>.DEBUG_CMD broadcasts (string
/// extra `cmd`) — the identical channel every generated native app carries. The Java shim
/// (Plugins/Android/PicoDebugCmdReceiver.java) registers the receiver and forwards each cmd via
/// UnitySendMessage to THIS GameObject (name must stay "PicoAgentBridge"). Fire-and-forget with a
/// main-thread hop — right for a drive channel, not for high-rate streams.
public sealed class PicoAgentBridge : MonoBehaviour
{
    public static readonly Dictionary<string, Action<string>> Commands =
        new Dictionary<string, Action<string>>();

    private void Awake()
    {
        gameObject.name = "PicoAgentBridge";
        DontDestroyOnLoad(gameObject);
#if UNITY_ANDROID && !UNITY_EDITOR
        using (var player = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
        using (var activity = player.GetStatic<AndroidJavaObject>("currentActivity"))
        using (var receiver = new AndroidJavaClass("com.picoagent.PicoDebugCmdReceiver"))
        {
            receiver.CallStatic("register", activity);
        }
#endif
        Debug.Log("PICOAGENT| bridge_ready");
    }

    public void OnDebugCmd(string cmd)
    {
        Debug.Log("PICOAGENT| cmd=" + cmd);
        if (cmd == "ping")
        {
            Debug.Log("PICOAGENT| pong");
            return;
        }
        int colon = cmd.IndexOf(':');
        string key = colon < 0 ? cmd : cmd.Substring(0, colon);
        string arg = colon < 0 ? "" : cmd.Substring(colon + 1);
        Action<string> handler;
        if (Commands.TryGetValue(key, out handler))
        {
            try { handler(arg); }
            catch (Exception e) { Debug.LogError("PICOAGENT| cmd_failed " + cmd + " " + e.Message); }
        }
        else
        {
            Debug.LogWarning("PICOAGENT| unknown_cmd " + cmd);
        }
    }
}
