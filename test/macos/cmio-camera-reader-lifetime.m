#define main cmio_camera_reader_cli_main
#include "../../scripts/macos/cmio-camera-reader.m"
#undef main

#include <signal.h>
#include <stdio.h>

static int Fail(NSString *message) {
    fprintf(stderr, "cmio-camera-reader lifetime test: %s\n", message.UTF8String);
    return 1;
}

int main(void) {
    @autoreleasepool {
        if (NormalizeExitCodeForStopRequest(0, 0) != 0 ||
            NormalizeExitCodeForStopRequest(0, SIGINT) != 128 + SIGINT ||
            NormalizeExitCodeForStopRequest(0, SIGTERM) != 128 + SIGTERM ||
            NormalizeExitCodeForStopRequest(0, SIGHUP) != 128 + SIGHUP ||
            NormalizeExitCodeForStopRequest(1, SIGTERM) != 1 ||
            NormalizeExitCodeForStopRequest(130, 0) != 130) {
            return Fail(@"stop-request exit-code normalization is not deterministic");
        }

        // A stop pending before the mode runs must short-circuit to 128+signal BEFORE any
        // CoreMediaIO topology access. The device UID here is valid but never resolved.
        const char *stoppedArgv[] = {
            "cmio-camera-reader",
            "--cmio-probe-only",
            "--device-uid", "00000000-0000-0000-0000-000000000001",
        };
        gStopRequested = SIGTERM;
        int stoppedResult = cmio_camera_reader_cli_main(
            (int)(sizeof(stoppedArgv) / sizeof(stoppedArgv[0])),
            stoppedArgv);
        gStopRequested = 0;
        if (stoppedResult != 128 + SIGTERM) {
            return Fail(@"CLI did not normalize a pending stop before CMIO topology access");
        }

        // JSONEscaped must emit valid JSON strings for any device/stream name a DAL may report.
        if (![JSONEscaped(@"a\"b") isEqualToString:@"a\\\"b"] ||
            ![JSONEscaped(@"a\\b") isEqualToString:@"a\\\\b"] ||
            ![JSONEscaped(@"a\nb") isEqualToString:@"a\\nb"] ||
            ![JSONEscaped(@"a\rb") isEqualToString:@"a\\rb"] ||
            ![JSONEscaped(@"a\tb") isEqualToString:@"a\\tb"]) {
            return Fail(@"JSONEscaped did not escape quote/backslash/newline/return/tab");
        }
        unichar controlUnit = 0x01;
        NSString *controlInput = [NSString stringWithCharacters:&controlUnit length:1];
        if (![JSONEscaped(controlInput) isEqualToString:@"\\u0001"]) {
            return Fail(@"JSONEscaped did not \\u-escape a control character");
        }
        if (![JSONEscaped(@"café Cam \U0001F3A5") isEqualToString:@"café Cam \U0001F3A5"]) {
            return Fail(@"JSONEscaped altered a printable unicode/emoji stream name");
        }

        // An AVCaptureDeviceInput may be constructed ONLY when already Authorized.
        if (CanConstructInput(AVAuthorizationStatusAuthorized) != YES ||
            CanConstructInput(AVAuthorizationStatusNotDetermined) != NO ||
            CanConstructInput(AVAuthorizationStatusDenied) != NO ||
            CanConstructInput(AVAuthorizationStatusRestricted) != NO) {
            return Fail(@"an AVCaptureDeviceInput must be constructible only when already Authorized");
        }
        if (![AuthStatusString(AVAuthorizationStatusAuthorized) isEqualToString:@"authorized"] ||
            ![AuthStatusString(AVAuthorizationStatusNotDetermined) isEqualToString:@"notDetermined"] ||
            ![AuthStatusString(AVAuthorizationStatusDenied) isEqualToString:@"denied"] ||
            ![AuthStatusString(AVAuthorizationStatusRestricted) isEqualToString:@"restricted"]) {
            return Fail(@"AVAuthorizationStatus string mapping is wrong");
        }

        // The fail-closed readback exit decision must never reach success (0) for an empty or static
        // capture — the only paths that reach a live camera in Task 5.
        if (AvfExitCode(0, 0, 2) != 74 ||   // zero frames captured
            AvfExitCode(3, 1, 2) != 75 ||   // three frames but only one distinct (static)
            AvfExitCode(2, 1, 2) != 75 ||   // exactly the requested frames, still static
            AvfExitCode(1, 2, 2) != 74 ||   // two distinct but fewer frames than requested
            AvfExitCode(2, 2, 2) != 0  ||   // exactly requested, changing -> success
            AvfExitCode(5, 4, 2) != 0) {    // more than requested, changing -> success
            return Fail(@"AvfExitCode fail-closed success logic is wrong");
        }
    }

    puts("cmio-camera-reader lifetime test: signal normalization and pre-CMIO stop passed");
    return 0;
}
