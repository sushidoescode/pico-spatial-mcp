// cmio-camera-reader — read-only host-side diagnostic for the v29.1 camera boundary.
//
// v29.1 scope: a single mode, --cmio-probe-only, that reports the exact target device's stream
// topology and current formats using PUBLIC CoreMediaIO property reads ONLY. It never copies a
// stream queue, starts a stream, dequeues/enqueues a sample, or writes a frame — direct CMIO client
// sample readback is an UNDOCUMENTED ownership contract (CMSimpleQueue delegates element lifetime
// externally; no retain annotation; Apple's documented source-consumer path is AVFoundation), so it
// stays a blocked contract, not compiled behavior. Task 4 will extend THIS SAME executable identity
// with --authorization-only and --avfoundation-readback so one retained binary owns their shared
// authorization guard.
#import <Foundation/Foundation.h>

#include <CoreMedia/CoreMedia.h>
#include <CoreMediaIO/CoreMediaIO.h>
#include <CoreVideo/CoreVideo.h>
#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const UInt32 kMaximumObjectIDs = 4096;
static NSString *const kRequiredDeviceName = @"Immersed Camera";

static volatile sig_atomic_t gStopRequested = 0;

typedef struct {
    __strong NSString *deviceUid;
    BOOL cmioProbeOnly;
    BOOL help;
} Options;

static void HandleSignal(int signalNumber) {
    gStopRequested = (sig_atomic_t)signalNumber;
}

static int NormalizeExitCodeForStopRequest(int exitCode, sig_atomic_t stopSignal) {
    return stopSignal > 0 && exitCode == 0 ? 128 + (int)stopSignal : exitCode;
}

static BOOL InstallSignalHandlers(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = HandleSignal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGHUP, &action, NULL) != 0) {
        fprintf(stderr, "cmio-camera-reader: failed to install shutdown signal handlers: %s\n", strerror(errno));
        return NO;
    }

    struct sigaction ignorePipe;
    memset(&ignorePipe, 0, sizeof(ignorePipe));
    ignorePipe.sa_handler = SIG_IGN;
    sigemptyset(&ignorePipe.sa_mask);
    if (sigaction(SIGPIPE, &ignorePipe, NULL) != 0) {
        fprintf(stderr, "cmio-camera-reader: failed to ignore SIGPIPE: %s\n", strerror(errno));
        return NO;
    }
    return YES;
}

static void PrintUsage(FILE *stream) {
    fprintf(stream,
            "Usage:\n"
            "  cmio-camera-reader --cmio-probe-only --device-uid UUID\n"
            "  cmio-camera-reader --help\n"
            "\n"
            "--cmio-probe-only reports the exact device's stream topology and current formats\n"
            "through public CoreMediaIO property reads ONLY. It does not copy a stream queue,\n"
            "start a stream, dequeue a sample, or write a frame.\n");
}

static BOOL ParseOptions(int argc, const char *argv[], Options *options) {
    NSMutableSet<NSString *> *seen = [NSMutableSet set];

    for (int index = 1; index < argc; index += 1) {
        NSString *argument = [NSString stringWithUTF8String:argv[index]];
        if ([argument isEqualToString:@"--help"]) {
            if ([seen containsObject:argument]) {
                fprintf(stderr, "cmio-camera-reader: duplicate argument --help\n");
                return NO;
            }
            [seen addObject:argument];
            options->help = YES;
            continue;
        }
        if ([argument isEqualToString:@"--cmio-probe-only"]) {
            if ([seen containsObject:argument]) {
                fprintf(stderr, "cmio-camera-reader: duplicate argument --cmio-probe-only\n");
                return NO;
            }
            [seen addObject:argument];
            options->cmioProbeOnly = YES;
            continue;
        }

        BOOL known = [argument isEqualToString:@"--device-uid"];
        if (!known) {
            fprintf(stderr, "cmio-camera-reader: unknown argument: %s\n", argv[index]);
            return NO;
        }
        if ([seen containsObject:argument]) {
            fprintf(stderr, "cmio-camera-reader: duplicate argument: %s\n", argv[index]);
            return NO;
        }
        [seen addObject:argument];
        if (index + 1 >= argc) {
            fprintf(stderr, "cmio-camera-reader: missing value for %s\n", argv[index]);
            return NO;
        }
        NSString *value = [NSString stringWithUTF8String:argv[index + 1]];
        if ([value hasPrefix:@"--"]) {
            fprintf(stderr, "cmio-camera-reader: missing value for %s\n", argv[index]);
            return NO;
        }
        index += 1;

        if ([argument isEqualToString:@"--device-uid"]) options->deviceUid = value;
    }

    if (options->help) {
        if (argc != 2) {
            fprintf(stderr, "cmio-camera-reader: --help must be used alone\n");
            return NO;
        }
        return YES;
    }

    // Exactly one mode must be selected. (Task 4 adds --authorization-only and
    // --avfoundation-readback to this count so the modes stay mutually exclusive.)
    int modeCount = options->cmioProbeOnly ? 1 : 0;
    if (modeCount != 1) {
        fprintf(stderr, "cmio-camera-reader: exactly one mode is required (e.g. --cmio-probe-only)\n");
        return NO;
    }

    if (options->cmioProbeOnly) {
        if (options->deviceUid.length == 0 || [[NSUUID alloc] initWithUUIDString:options->deviceUid] == nil) {
            fprintf(stderr, "cmio-camera-reader: --device-uid must be a non-empty UUID\n");
            return NO;
        }
    }
    return YES;
}

static BOOL IsPrintableFourCC(uint32_t value) {
    for (int shift = 24; shift >= 0; shift -= 8) {
        unsigned char byte = (unsigned char)((value >> shift) & 0xffu);
        if (byte < 0x20 || byte > 0x7e) return NO;
    }
    return YES;
}

static void PrintOSStatus(NSString *operation, OSStatus status) {
    uint32_t raw = (uint32_t)status;
    fprintf(stderr, "cmio-camera-reader: %s failed: OSStatus %d", operation.UTF8String, (int)status);
    if (IsPrintableFourCC(raw)) {
        fprintf(stderr, " ('%c%c%c%c')",
                (int)((raw >> 24) & 0xffu), (int)((raw >> 16) & 0xffu),
                (int)((raw >> 8) & 0xffu), (int)(raw & 0xffu));
    } else {
        fprintf(stderr, " (0x%08x)", raw);
    }
    fputc('\n', stderr);
}

static NSString *FourCCString(OSType value) {
    uint32_t raw = (uint32_t)value;
    if (!IsPrintableFourCC(raw)) return [NSString stringWithFormat:@"0x%08x", raw];
    return [NSString stringWithFormat:@"%c%c%c%c",
            (int)((raw >> 24) & 0xffu), (int)((raw >> 16) & 0xffu),
            (int)((raw >> 8) & 0xffu), (int)(raw & 0xffu)];
}

static NSString *JSONEscaped(NSString *value) {
    NSMutableString *escaped = [NSMutableString stringWithCapacity:value.length + 2];
    for (NSUInteger index = 0; index < value.length; index += 1) {
        unichar character = [value characterAtIndex:index];
        switch (character) {
            case '"': [escaped appendString:@"\\\""]; break;
            case '\\': [escaped appendString:@"\\\\"]; break;
            case '\n': [escaped appendString:@"\\n"]; break;
            case '\r': [escaped appendString:@"\\r"]; break;
            case '\t': [escaped appendString:@"\\t"]; break;
            default:
                if (character < 0x20) {
                    [escaped appendFormat:@"\\u%04x", (unsigned)character];
                } else {
                    [escaped appendFormat:@"%C", character];
                }
        }
    }
    return escaped;
}

static CMIOObjectPropertyAddress PropertyAddress(CMIOObjectPropertySelector selector,
                                                  CMIOObjectPropertyScope scope) {
    CMIOObjectPropertyAddress address = {
        selector,
        scope,
        kCMIOObjectPropertyElementMain,
    };
    return address;
}

static BOOL HasGlobalProperty(CMIOObjectID objectID, CMIOObjectPropertySelector selector) {
    CMIOObjectPropertyAddress address = PropertyAddress(selector, kCMIOObjectPropertyScopeGlobal);
    return CMIOObjectHasProperty(objectID, &address) ? YES : NO;
}

static BOOL ReadProperty(CMIOObjectID objectID,
                         CMIOObjectPropertySelector selector,
                         CMIOObjectPropertyScope scope,
                         void *value,
                         UInt32 expectedSize,
                         NSString *label) {
    CMIOObjectPropertyAddress address = PropertyAddress(selector, scope);
    if (!CMIOObjectHasProperty(objectID, &address)) {
        fprintf(stderr, "cmio-camera-reader: required property absent: %s\n", label.UTF8String);
        return NO;
    }
    UInt32 size = 0;
    OSStatus status = CMIOObjectGetPropertyDataSize(objectID, &address, 0, NULL, &size);
    if (status != noErr) {
        PrintOSStatus([NSString stringWithFormat:@"read %@ size", label], status);
        return NO;
    }
    if (size != expectedSize) {
        fprintf(stderr, "cmio-camera-reader: %s has size %u, expected %u\n",
                label.UTF8String, (unsigned)size, (unsigned)expectedSize);
        return NO;
    }
    UInt32 used = 0;
    status = CMIOObjectGetPropertyData(objectID, &address, 0, NULL, expectedSize, &used, value);
    if (status != noErr) {
        PrintOSStatus([NSString stringWithFormat:@"read %@", label], status);
        return NO;
    }
    if (used != expectedSize) {
        fprintf(stderr, "cmio-camera-reader: %s returned %u bytes, expected %u\n",
                label.UTF8String, (unsigned)used, (unsigned)expectedSize);
        return NO;
    }
    return YES;
}

static NSString *CopyStringProperty(CMIOObjectID objectID,
                                    CMIOObjectPropertySelector selector,
                                    CMIOObjectPropertyScope scope,
                                    NSString *label) {
    CFStringRef value = NULL;
    if (!ReadProperty(objectID, selector, scope, &value, sizeof(value), label)) return nil;
    if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) {
        fprintf(stderr, "cmio-camera-reader: %s did not return a CFString\n", label.UTF8String);
        if (value != NULL) CFRelease(value);
        return nil;
    }
    NSString *copied = [(__bridge NSString *)value copy];
    CFRelease(value);
    return copied;
}

static BOOL CopyObjectIDs(CMIOObjectID objectID,
                          CMIOObjectPropertySelector selector,
                          CMIOObjectPropertyScope scope,
                          NSString *label,
                          CMIOObjectID **idsOut,
                          UInt32 *countOut) {
    *idsOut = NULL;
    *countOut = 0;
    CMIOObjectPropertyAddress address = PropertyAddress(selector, scope);
    if (!CMIOObjectHasProperty(objectID, &address)) {
        fprintf(stderr, "cmio-camera-reader: required property absent: %s\n", label.UTF8String);
        return NO;
    }
    UInt32 size = 0;
    OSStatus status = CMIOObjectGetPropertyDataSize(objectID, &address, 0, NULL, &size);
    if (status != noErr) {
        PrintOSStatus([NSString stringWithFormat:@"read %@ size", label], status);
        return NO;
    }
    if (size % sizeof(CMIOObjectID) != 0 || size > kMaximumObjectIDs * sizeof(CMIOObjectID)) {
        fprintf(stderr, "cmio-camera-reader: %s returned invalid byte size %u\n", label.UTF8String, (unsigned)size);
        return NO;
    }
    if (size == 0) {
        return YES;  // Zero streams is a valid, honestly-reported topology.
    }
    CMIOObjectID *ids = calloc(1, size);
    if (ids == NULL) {
        fprintf(stderr, "cmio-camera-reader: allocation failed for %s\n", label.UTF8String);
        return NO;
    }
    UInt32 returnedSize = size;
    status = CMIOObjectGetPropertyData(objectID, &address, 0, NULL, size, &returnedSize, ids);
    if (status != noErr) {
        PrintOSStatus([NSString stringWithFormat:@"read %@", label], status);
        free(ids);
        return NO;
    }
    if (returnedSize > size || returnedSize % sizeof(CMIOObjectID) != 0) {
        fprintf(stderr, "cmio-camera-reader: %s returned invalid data byte size %u\n",
                label.UTF8String, (unsigned)returnedSize);
        free(ids);
        return NO;
    }
    *idsOut = ids;
    *countOut = returnedSize / (UInt32)sizeof(CMIOObjectID);
    return YES;
}

static CMIODeviceID ResolveExactDevice(NSString *expectedUid) {
    CMIOObjectID *deviceIDs = NULL;
    UInt32 deviceCount = 0;
    if (!CopyObjectIDs(kCMIOObjectSystemObject,
                       kCMIOHardwarePropertyDevices,
                       kCMIOObjectPropertyScopeGlobal,
                       @"CMIO device list",
                       &deviceIDs,
                       &deviceCount)) return kCMIODeviceUnknown;

    CMIODeviceID matchedDevice = kCMIODeviceUnknown;
    UInt32 matchedCount = 0;
    for (UInt32 index = 0; index < deviceCount; index += 1) {
        NSString *uid = CopyStringProperty(deviceIDs[index],
                                           kCMIODevicePropertyDeviceUID,
                                           kCMIOObjectPropertyScopeGlobal,
                                           @"device UID");
        if (uid != nil && [uid isEqualToString:expectedUid]) {
            matchedDevice = deviceIDs[index];
            matchedCount += 1;
        }
    }
    free(deviceIDs);
    if (matchedCount != 1) {
        fprintf(stderr, "cmio-camera-reader: exact device UID %s matched %u CMIO devices; expected 1\n",
                expectedUid.UTF8String, (unsigned)matchedCount);
        return kCMIODeviceUnknown;
    }
    return matchedDevice;
}

// Reports one stream's identity and current format read-only. Fails closed on any missing,
// mistyped, direction-mismatched, or non-video stream property.
static BOOL EmitStreamTopology(CMIOStreamID streamID, UInt32 index, UInt32 *inputCountOut, UInt32 *outputCountOut) {
    NSString *streamName = CopyStringProperty(streamID,
                                              kCMIOObjectPropertyName,
                                              kCMIOObjectPropertyScopeGlobal,
                                              @"stream name");
    if (streamName == nil) return NO;

    UInt32 direction = UINT32_MAX;
    if (!ReadProperty(streamID,
                      kCMIOStreamPropertyDirection,
                      kCMIOObjectPropertyScopeGlobal,
                      &direction,
                      sizeof(direction),
                      @"stream direction")) return NO;
    if (direction != 0 && direction != 1) {
        fprintf(stderr, "cmio-camera-reader: stream %u has unexpected direction %u; expected 0 or 1\n",
                (unsigned)index, (unsigned)direction);
        return NO;
    }

    CMFormatDescriptionRef formatDescription = NULL;
    if (!ReadProperty(streamID,
                      kCMIOStreamPropertyFormatDescription,
                      kCMIOObjectPropertyScopeGlobal,
                      &formatDescription,
                      sizeof(formatDescription),
                      @"stream format")) return NO;
    if (formatDescription == NULL ||
        CFGetTypeID(formatDescription) != CMFormatDescriptionGetTypeID() ||
        CMFormatDescriptionGetMediaType(formatDescription) != kCMMediaType_Video) {
        fprintf(stderr, "cmio-camera-reader: stream %u format is not video\n", (unsigned)index);
        if (formatDescription != NULL) CFRelease(formatDescription);
        return NO;
    }
    OSType subtype = CMFormatDescriptionGetMediaSubType(formatDescription);
    CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription);
    CFRelease(formatDescription);

    Float64 frameRate = 0.0;
    if (HasGlobalProperty(streamID, kCMIOStreamPropertyFrameRate)) {
        if (!ReadProperty(streamID,
                          kCMIOStreamPropertyFrameRate,
                          kCMIOObjectPropertyScopeGlobal,
                          &frameRate,
                          sizeof(frameRate),
                          @"stream frame rate")) return NO;
        if (!isfinite(frameRate)) frameRate = 0.0;
    }

    if (direction == 1) *inputCountOut += 1;
    else *outputCountOut += 1;

    int result = fprintf(stdout,
                         "{\"event\":\"stream\",\"index\":%u,\"streamId\":%u,\"name\":\"%s\","
                         "\"direction\":%u,\"mediaType\":\"vide\",\"subType\":\"%s\","
                         "\"width\":%d,\"height\":%d,\"frameRate\":%.9g}\n",
                         (unsigned)index,
                         (unsigned)streamID,
                         JSONEscaped(streamName).UTF8String,
                         (unsigned)direction,
                         JSONEscaped(FourCCString(subtype)).UTF8String,
                         dimensions.width,
                         dimensions.height,
                         frameRate);
    return result >= 0 && fflush(stdout) == 0;
}

static BOOL ProbeDeviceTopology(NSString *expectedUid) {
    CMIODeviceID device = ResolveExactDevice(expectedUid);
    if (device == kCMIODeviceUnknown) return NO;

    NSString *deviceName = CopyStringProperty(device,
                                              kCMIOObjectPropertyName,
                                              kCMIOObjectPropertyScopeGlobal,
                                              @"device name");
    if (deviceName == nil || ![deviceName isEqualToString:kRequiredDeviceName]) {
        const char *actualName = deviceName == nil ? "(null)" : deviceName.UTF8String;
        fprintf(stderr, "cmio-camera-reader: device UID %s has name '%s'; required '%s'\n",
                expectedUid.UTF8String, actualName, kRequiredDeviceName.UTF8String);
        return NO;
    }

    CMIOObjectID *streamIDs = NULL;
    UInt32 streamCount = 0;
    if (!CopyObjectIDs(device,
                       kCMIODevicePropertyStreams,
                       kCMIOObjectPropertyScopeGlobal,
                       @"device stream list",
                       &streamIDs,
                       &streamCount)) return NO;

    if (fprintf(stdout,
                "{\"event\":\"device\",\"deviceUid\":\"%s\",\"deviceName\":\"%s\",\"streamCount\":%u}\n",
                JSONEscaped(expectedUid).UTF8String,
                JSONEscaped(deviceName).UTF8String,
                (unsigned)streamCount) < 0 || fflush(stdout) != 0) {
        free(streamIDs);
        return NO;
    }

    UInt32 inputCount = 0;
    UInt32 outputCount = 0;
    for (UInt32 index = 0; index < streamCount; index += 1) {
        if (gStopRequested) {
            free(streamIDs);
            return YES;  // A pending stop is honored between read-only stream reports.
        }
        if (!EmitStreamTopology(streamIDs[index], index, &inputCount, &outputCount)) {
            free(streamIDs);
            return NO;
        }
    }
    free(streamIDs);

    int result = fprintf(stdout,
                         "{\"event\":\"probe\",\"ok\":true,\"mode\":\"cmio-probe-only\",\"deviceUid\":\"%s\","
                         "\"deviceName\":\"%s\",\"streamCount\":%u,\"inputStreams\":%u,\"outputStreams\":%u,"
                         "\"readOnly\":true}\n",
                         JSONEscaped(expectedUid).UTF8String,
                         JSONEscaped(deviceName).UTF8String,
                         (unsigned)streamCount,
                         (unsigned)inputCount,
                         (unsigned)outputCount);
    return result >= 0 && fflush(stdout) == 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        Options options = {0};
        if (!ParseOptions(argc, argv, &options)) {
            PrintUsage(stderr);
            return 64;
        }
        if (options.help) {
            PrintUsage(stdout);
            return 0;
        }
        if (!InstallSignalHandlers()) return 1;
        if (gStopRequested) return NormalizeExitCodeForStopRequest(0, gStopRequested);

        if (options.cmioProbeOnly) {
            if (!ProbeDeviceTopology(options.deviceUid)) return 69;
            return NormalizeExitCodeForStopRequest(0, gStopRequested);
        }

        fprintf(stderr, "cmio-camera-reader: no mode selected\n");
        return 64;
    }
}
