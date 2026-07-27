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
#import <AVFoundation/AVFoundation.h>

#include <CommonCrypto/CommonDigest.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreMediaIO/CoreMediaIO.h>
#include <CoreVideo/CoreVideo.h>
#include <ImageIO/ImageIO.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <mach/mach_time.h>
#include <math.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const UInt32 kMaximumObjectIDs = 4096;
static const NSUInteger kMaximumReadbackFrames = 240;
// Each preview costs an in-callback PNG encode, a disk write, and a second SHA-256, so a preview
// run stays short. --no-preview removes all three, which is what makes a longer rate run a
// measurement of the source rather than of this process's own encoder.
static const NSUInteger kMaximumReadbackFramesNoPreview = 3600;
static const uint64_t kMaximumReadbackTimeoutMs = 60000;
// A pending stop must interrupt a long readback, so the bounded wait is taken in short slices.
static const uint64_t kStopPollIntervalNs = 100 * NSEC_PER_MSEC;
static NSString *const kRequiredDeviceName = @"Immersed Camera";

// The bound follows the MODE, never the order the flags appeared in argv.
static NSUInteger MaximumReadbackFramesForMode(BOOL noPreview) {
    return noPreview ? kMaximumReadbackFramesNoPreview : kMaximumReadbackFrames;
}

static volatile sig_atomic_t gStopRequested = 0;

typedef struct {
    __strong NSString *deviceUid;
    __strong NSString *outputDir;
    NSUInteger frames;
    uint64_t timeoutMs;
    BOOL cmioProbeOnly;
    BOOL authorizationOnly;
    BOOL avfoundationReadback;
    BOOL noPreview;
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
            "  cmio-camera-reader --authorization-only\n"
            "  cmio-camera-reader --avfoundation-readback --device-uid UUID\n"
            "      --output-dir DIR --frames N --timeout-ms MS [--no-preview]\n"
            "  cmio-camera-reader --help\n"
            "\n"
            "--cmio-probe-only reports the exact device's stream topology and current formats\n"
            "through public CoreMediaIO property reads ONLY (no queue copy, stream start,\n"
            "dequeue, or frame write).\n"
            "--authorization-only reports this executable's canonical path/SHA-256, code-signing\n"
            "identity when present, and its AVCaptureDevice video authorization status. It never\n"
            "requests access, constructs a capture input, starts a session, or writes a frame.\n"
            "--avfoundation-readback captures a bounded frame set from the exact device unique ID,\n"
            "but ONLY when this client is already authorized; otherwise it reports blocked.\n"
            "--no-preview drops the in-callback PNG encode, disk write, and preview hash, leaving\n"
            "only the raw frame digest. It raises the --frames bound from 240 to 3600 because the\n"
            "delegate no longer perturbs the rate it is measuring.\n");
}

static BOOL ParseSize(NSString *text, size_t *valueOut) {
    if (text.length == 0) return NO;
    NSScanner *scanner = [NSScanner scannerWithString:text];
    unsigned long long parsed = 0;
    if (![scanner scanUnsignedLongLong:&parsed] || !scanner.isAtEnd || parsed > SIZE_MAX) return NO;
    *valueOut = (size_t)parsed;
    return YES;
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
        if ([argument isEqualToString:@"--authorization-only"]) {
            if ([seen containsObject:argument]) {
                fprintf(stderr, "cmio-camera-reader: duplicate argument --authorization-only\n");
                return NO;
            }
            [seen addObject:argument];
            options->authorizationOnly = YES;
            continue;
        }
        if ([argument isEqualToString:@"--avfoundation-readback"]) {
            if ([seen containsObject:argument]) {
                fprintf(stderr, "cmio-camera-reader: duplicate argument --avfoundation-readback\n");
                return NO;
            }
            [seen addObject:argument];
            options->avfoundationReadback = YES;
            continue;
        }
        if ([argument isEqualToString:@"--no-preview"]) {
            if ([seen containsObject:argument]) {
                fprintf(stderr, "cmio-camera-reader: duplicate argument --no-preview\n");
                return NO;
            }
            [seen addObject:argument];
            options->noPreview = YES;
            continue;
        }

        BOOL known = [argument isEqualToString:@"--device-uid"] ||
                     [argument isEqualToString:@"--output-dir"] ||
                     [argument isEqualToString:@"--frames"] ||
                     [argument isEqualToString:@"--timeout-ms"];
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
        else if ([argument isEqualToString:@"--output-dir"]) options->outputDir = value;
        else if ([argument isEqualToString:@"--frames"]) {
            size_t parsed = 0;
            // The UPPER bound depends on --no-preview, which may still appear later in argv, so
            // only the format and the positive minimum are decided here.
            if (!ParseSize(value, &parsed) || parsed < 1) {
                fprintf(stderr, "cmio-camera-reader: --frames must be a positive decimal integer\n");
                return NO;
            }
            options->frames = (NSUInteger)parsed;
        } else if ([argument isEqualToString:@"--timeout-ms"]) {
            size_t parsed = 0;
            if (!ParseSize(value, &parsed) || parsed < 1 || (uint64_t)parsed > kMaximumReadbackTimeoutMs) {
                fprintf(stderr, "cmio-camera-reader: --timeout-ms must be an integer in 1..%llu\n", (unsigned long long)kMaximumReadbackTimeoutMs);
                return NO;
            }
            options->timeoutMs = (uint64_t)parsed;
        }
    }

    if (options->help) {
        if (argc != 2) {
            fprintf(stderr, "cmio-camera-reader: --help must be used alone\n");
            return NO;
        }
        return YES;
    }

    // Exactly one mode must be selected so the modes can never be combined.
    int modeCount = (options->cmioProbeOnly ? 1 : 0) +
                    (options->authorizationOnly ? 1 : 0) +
                    (options->avfoundationReadback ? 1 : 0);
    if (modeCount != 1) {
        fprintf(stderr, "cmio-camera-reader: exactly one mode is required "
                        "(--cmio-probe-only, --authorization-only, or --avfoundation-readback)\n");
        return NO;
    }

    if (options->cmioProbeOnly || options->avfoundationReadback) {
        if (options->deviceUid.length == 0 || [[NSUUID alloc] initWithUUIDString:options->deviceUid] == nil) {
            fprintf(stderr, "cmio-camera-reader: --device-uid must be a non-empty UUID\n");
            return NO;
        }
    }
    if (options->avfoundationReadback) {
        if (options->outputDir.length == 0) {
            fprintf(stderr, "cmio-camera-reader: --avfoundation-readback requires --output-dir\n");
            return NO;
        }
        if (options->frames < 1) {
            fprintf(stderr, "cmio-camera-reader: --avfoundation-readback requires --frames (>=1)\n");
            return NO;
        }
        // Both flags are known here, so the bound follows the selected mode rather than argv order.
        NSUInteger maximumFrames = MaximumReadbackFramesForMode(options->noPreview);
        if (options->frames > maximumFrames) {
            fprintf(stderr, "cmio-camera-reader: --frames must be an integer in 1..%lu %s\n",
                    (unsigned long)maximumFrames,
                    options->noPreview ? "with --no-preview" : "when previews are written");
            return NO;
        }
        if (options->timeoutMs < 1) {
            fprintf(stderr, "cmio-camera-reader: --avfoundation-readback requires --timeout-ms (>=1)\n");
            return NO;
        }
    }
    if ((options->cmioProbeOnly || options->authorizationOnly) &&
        (options->outputDir.length > 0 || options->frames > 0 || options->timeoutMs > 0 || options->noPreview)) {
        fprintf(stderr, "cmio-camera-reader: --output-dir/--frames/--timeout-ms/--no-preview are only valid with --avfoundation-readback\n");
        return NO;
    }
    if (options->authorizationOnly && options->deviceUid.length > 0) {
        fprintf(stderr, "cmio-camera-reader: --device-uid is not valid with --authorization-only\n");
        return NO;
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

static NSString *HexEncode(const unsigned char *digest, size_t length) {
    NSMutableString *encoded = [NSMutableString stringWithCapacity:length * 2];
    for (size_t index = 0; index < length; index += 1) [encoded appendFormat:@"%02x", digest[index]];
    return encoded;
}

static NSString *SHA256HexOfData(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    return HexEncode(digest, CC_SHA256_DIGEST_LENGTH);
}

static NSString *CanonicalExecutablePath(void) {
    uint32_t size = 0;
    _NSGetExecutablePath(NULL, &size);
    if (size == 0) return nil;
    char *buffer = malloc(size);
    if (buffer == NULL) return nil;
    NSString *path = nil;
    if (_NSGetExecutablePath(buffer, &size) == 0) {
        char resolved[PATH_MAX];
        if (realpath(buffer, resolved) != NULL) path = [NSString stringWithUTF8String:resolved];
        else path = [NSString stringWithUTF8String:buffer];
    }
    free(buffer);
    return path;
}

// Returns the sealed signing identifier when the binary is signed, nil when it is unsigned (the
// kSecCodeInfoIdentifier key is present iff signed). Read-only; verifies nothing.
static NSString *CopyCodeSigningIdentity(NSString *path) {
    if (path == nil) return nil;
    CFURLRef url = (__bridge_retained CFURLRef)[NSURL fileURLWithPath:path];
    SecStaticCodeRef code = NULL;
    OSStatus status = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
    CFRelease(url);
    if (status != errSecSuccess || code == NULL) {
        if (code != NULL) CFRelease(code);
        return nil;
    }
    CFDictionaryRef information = NULL;
    status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information);
    NSString *identity = nil;
    if (status == errSecSuccess && information != NULL) {
        const void *identifier = CFDictionaryGetValue(information, kSecCodeInfoIdentifier);
        if (identifier != NULL && CFGetTypeID(identifier) == CFStringGetTypeID()) {
            identity = [(__bridge NSString *)identifier copy];
        }
    }
    if (information != NULL) CFRelease(information);
    CFRelease(code);
    return identity;
}

static NSString *AuthStatusString(AVAuthorizationStatus status) {
    switch (status) {
        case AVAuthorizationStatusAuthorized: return @"authorized";
        case AVAuthorizationStatusDenied: return @"denied";
        case AVAuthorizationStatusRestricted: return @"restricted";
        case AVAuthorizationStatusNotDetermined: return @"notDetermined";
    }
    return @"unknown";
}

// The single authorization decision: an AVCaptureDeviceInput may be constructed ONLY when the
// client is already Authorized. notDetermined/denied/restricted all return NO, so the readback
// path blocks before it can implicitly prompt or open the device.
static BOOL CanConstructInput(AVAuthorizationStatus status) {
    return status == AVAuthorizationStatusAuthorized;
}

static int EmitAuthorization(void) {
    NSString *path = CanonicalExecutablePath();
    NSString *hash = nil;
    if (path != nil) {
        NSData *data = [NSData dataWithContentsOfFile:path];
        if (data != nil) hash = SHA256HexOfData(data);
    }
    NSString *identity = CopyCodeSigningIdentity(path);
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];

    NSString *hashJson = hash != nil ? [NSString stringWithFormat:@"\"%@\"", hash] : @"null";
    NSString *identityJson = identity != nil ? [NSString stringWithFormat:@"\"%@\"", JSONEscaped(identity)] : @"null";
    int result = fprintf(stdout,
                         "{\"event\":\"authorization\",\"mode\":\"authorization-only\",\"executablePath\":\"%s\","
                         "\"executableSha256\":%s,\"codeSigningIdentity\":%s,\"authStatus\":\"%s\","
                         "\"canConstructInput\":%s}\n",
                         path != nil ? JSONEscaped(path).UTF8String : "",
                         hashJson.UTF8String,
                         identityJson.UTF8String,
                         AuthStatusString(status).UTF8String,
                         CanConstructInput(status) ? "true" : "false");
    return (result >= 0 && fflush(stdout) == 0) ? 0 : 1;
}

static BOOL WriteBGRAToPNG(const uint8_t *base, size_t width, size_t height, size_t bytesPerRow, NSString *path) {
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    if (colorSpace == NULL) return NO;
    CGBitmapInfo bitmapInfo = (CGBitmapInfo)kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little;
    CGContextRef context = CGBitmapContextCreate((void *)base, width, height, 8, bytesPerRow, colorSpace, bitmapInfo);
    CGColorSpaceRelease(colorSpace);
    if (context == NULL) return NO;
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (image == NULL) return NO;
    CFURLRef url = (__bridge_retained CFURLRef)[NSURL fileURLWithPath:path];
    CGImageDestinationRef destination = CGImageDestinationCreateWithURL(url, CFSTR("public.png"), 1, NULL);
    CFRelease(url);
    if (destination == NULL) {
        CGImageRelease(image);
        return NO;
    }
    CGImageDestinationAddImage(destination, image, NULL);
    BOOL ok = CGImageDestinationFinalize(destination) ? YES : NO;
    CFRelease(destination);
    CGImageRelease(image);
    return ok;
}

// Mach ticks are NOT nanoseconds on every machine (Apple silicon counts at 24 MHz), so a raw
// mach_absolute_time() value would still parse, still validate, and still yield a plausible-looking
// latency while being ~41x wrong. The sibling producer stamps each enqueue with this same monotonic
// clock scaled by this same timebase, and the throughput analyzer subtracts one from the other, so
// the two binaries must agree on scale as well as on origin.
static uint64_t NanosecondsForMachTicks(uint64_t ticks, mach_timebase_info_data_t timebase) {
    if (timebase.numer == 0 || timebase.denom == 0) return 0;
    __uint128_t scaled = (__uint128_t)ticks * timebase.numer;
    return (uint64_t)(scaled / timebase.denom);
}

// The timebase is constant for the life of the process, and the sample-buffer delegate runs on a
// capture queue that cannot be handed one, so it is read once. An unreadable timebase is caught by
// the readback path before any session starts, rather than silently emitting a wrong-scale stamp.
static mach_timebase_info_data_t HostTimebase(void) {
    static mach_timebase_info_data_t timebase;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        if (mach_timebase_info(&timebase) != KERN_SUCCESS) {
            timebase.numer = 0;
            timebase.denom = 0;
        }
    });
    return timebase;
}

static uint64_t MachAbsoluteToNanoseconds(uint64_t ticks) {
    return NanosecondsForMachTicks(ticks, HostTimebase());
}

// Factored out so the reported unit is provable without a capture session: elapsedMs is only
// computed on the live readback path, and a missing divisor there would look entirely plausible.
static double MillisecondsForNanoseconds(uint64_t nanoseconds) {
    return (double)nanoseconds / 1e6;
}

@interface FrameCollector : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
- (instancetype)initWithTarget:(NSUInteger)target
                     outputDir:(NSString *)outputDir
                 writePreviews:(BOOL)writePreviews;
@property (nonatomic, readonly) NSMutableArray<NSString *> *records;
@property (nonatomic, readonly) NSMutableSet<NSString *> *distinctRaw;
@property (nonatomic, readonly) dispatch_semaphore_t done;
// AVFoundation reports discarded frames on the delegate queue. Counting them is what keeps a drop
// from looking like a slow source. Read after the delegate has been detached and the queue drained.
- (uint64_t)droppedFrames;
@end

@implementation FrameCollector {
    NSUInteger _target;
    NSString *_outputDir;
    BOOL _writePreviews;
    _Atomic uint64_t _droppedFrames;
}

- (instancetype)initWithTarget:(NSUInteger)target
                     outputDir:(NSString *)outputDir
                 writePreviews:(BOOL)writePreviews {
    self = [super init];
    if (self != nil) {
        _target = target;
        _outputDir = [outputDir copy];
        _writePreviews = writePreviews;
        _records = [NSMutableArray array];
        _distinctRaw = [NSMutableSet set];
        _done = dispatch_semaphore_create(0);
        atomic_init(&_droppedFrames, 0);
    }
    return self;
}

- (uint64_t)droppedFrames {
    return atomic_load_explicit(&_droppedFrames, memory_order_relaxed);
}

- (void)captureOutput:(AVCaptureOutput *)output
      didDropSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
    (void)output;
    (void)sampleBuffer;
    (void)connection;
    atomic_fetch_add_explicit(&self->_droppedFrames, 1, memory_order_relaxed);
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
           fromConnection:(AVCaptureConnection *)connection {
    // The first statement, before any hashing or encoding: this is the arrival time the throughput
    // analyzer subtracts the producer's enqueue stamp from, so it must not include our own work.
    const uint64_t hostTimeNs = MachAbsoluteToNanoseconds(mach_absolute_time());
    (void)output;
    (void)connection;
    if (_records.count >= _target) return;
    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (imageBuffer == NULL) return;
    if (CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return;

    size_t width = CVPixelBufferGetWidth(imageBuffer);
    size_t height = CVPixelBufferGetHeight(imageBuffer);
    size_t bytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer);
    OSType pixelFormat = CVPixelBufferGetPixelFormatType(imageBuffer);
    const uint8_t *base = CVPixelBufferGetBaseAddress(imageBuffer);

    NSString *rawHash = nil;
    NSString *previewHash = nil;
    NSString *previewPath = nil;
    if (base != NULL && width > 0 && height > 0 && bytesPerRow >= width * 4) {
        CC_SHA256_CTX shaContext;
        CC_SHA256_Init(&shaContext);
        for (size_t row = 0; row < height; row += 1) {
            CC_SHA256_Update(&shaContext, base + row * bytesPerRow, (CC_LONG)(width * 4));
        }
        unsigned char digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256_Final(digest, &shaContext);
        rawHash = HexEncode(digest, CC_SHA256_DIGEST_LENGTH);
        if (_writePreviews) {
            previewPath = [_outputDir stringByAppendingPathComponent:
                           [NSString stringWithFormat:@"avf-frame-%03lu.png", (unsigned long)_records.count]];
            if (WriteBGRAToPNG(base, width, height, bytesPerRow, previewPath)) {
                NSData *png = [NSData dataWithContentsOfFile:previewPath];
                if (png != nil) previewHash = SHA256HexOfData(png);
            }
        }
    }

    CMTime presentation = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    double presentationMs = CMTIME_IS_VALID(presentation) ? CMTimeGetSeconds(presentation) * 1000.0 : -1.0;
    if (!isfinite(presentationMs)) presentationMs = -1.0;  // a degenerate CMTime must not emit inf/nan JSON
    CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
    if (rawHash == nil) return;

    [_distinctRaw addObject:rawHash];
    // The preview fields stay present in both modes and become JSON null when no preview was
    // written, so the record shape does not change under --no-preview.
    NSString *previewHashJson = previewHash != nil ? [NSString stringWithFormat:@"\"%@\"", previewHash] : @"null";
    NSString *previewPathJson = previewPath != nil
        ? [NSString stringWithFormat:@"\"%@\"", JSONEscaped(previewPath)]
        : @"null";
    NSString *record = [NSString stringWithFormat:
                        @"{\"event\":\"frame\",\"index\":%lu,\"width\":%lu,\"height\":%lu,\"pixelFormat\":\"%@\","
                        @"\"hostTimeNs\":%llu,\"presentationTimeMs\":%.3f,\"rawSha256\":\"%@\","
                        @"\"previewSha256\":%@,\"previewPath\":%@}",
                        (unsigned long)_records.count, (unsigned long)width, (unsigned long)height,
                        JSONEscaped(FourCCString(pixelFormat)), (unsigned long long)hostTimeNs,
                        presentationMs, rawHash, previewHashJson, previewPathJson];
    [_records addObject:record];
    if (_records.count >= _target) dispatch_semaphore_signal(_done);
}

@end

// The fail-closed success-side decision, factored out so it is unit-testable without a live camera.
// A changing-card success (0) requires at least the requested frames AND two distinct raw frames;
// zero frames or a single static frame can never reach 0.
static int AvfExitCode(NSUInteger captured, NSUInteger distinct, NSUInteger requested) {
    if (captured == 0) return 74;         // zero frames is never a success
    if (distinct < 2) return 75;          // a single repeated static frame is not a changing delivery
    if (captured < requested) return 74;  // fewer frames than requested within the bound
    return 0;
}

// Built as a string, like the per-frame record, so the exact wire format the throughput analyzer
// parses is checkable without a capture session. `ok` is derived from AvfExitCode rather than
// recomputed, so the reported verdict and the process exit code can never disagree.
static NSString *ReadbackSummaryRecord(NSString *deviceUid,
                                       NSString *outputDir,
                                       NSUInteger requestedFrames,
                                       NSUInteger captured,
                                       NSUInteger distinct,
                                       uint64_t dropped,
                                       double elapsedMs,
                                       BOOL timedOut,
                                       BOOL noPreview) {
    BOOL ok = AvfExitCode(captured, distinct, requestedFrames) == 0;
    BOOL changing = distinct >= 2;
    // elapsedMs is only interpretable alongside the mode that produced it: with previews on, this
    // process's own PNG encode is inside the measured span.
    return [NSString stringWithFormat:
            @"{\"event\":\"readback\",\"mode\":\"avfoundation-readback\",\"ok\":%@,\"authStatus\":\"authorized\","
            @"\"deviceUid\":\"%@\",\"requestedFrames\":%lu,\"framesCaptured\":%lu,\"distinctRawHashes\":%lu,"
            @"\"dropped\":%llu,\"elapsedMs\":%.3f,\"changingFrames\":%@,\"timedOut\":%@,\"previews\":%@,"
            @"\"outputDir\":\"%@\"}",
            ok ? @"true" : @"false",
            JSONEscaped(deviceUid),
            (unsigned long)requestedFrames,
            (unsigned long)captured,
            (unsigned long)distinct,
            (unsigned long long)dropped,
            elapsedMs,
            changing ? @"true" : @"false",
            timedOut ? @"true" : @"false",
            noPreview ? @"false" : @"true",
            JSONEscaped(outputDir)];
}

static int RunAvfReadback(NSString *deviceUid,
                          NSString *outputDir,
                          NSUInteger frames,
                          uint64_t timeoutMs,
                          BOOL noPreview) {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
    if (!CanConstructInput(status)) {
        // Blocked, not failed. No input is constructed, no session started, no prompt shown.
        fprintf(stdout,
                "{\"event\":\"blocked\",\"mode\":\"avfoundation-readback\",\"authStatus\":\"%s\","
                "\"reason\":\"camera authorization is not authorized for this client\"}\n",
                AuthStatusString(status).UTF8String);
        fflush(stdout);
        return 77;
    }

    // Fail closed before any device is touched: without a readable timebase the per-frame stamps
    // would be a plausible-looking wrong scale rather than an obvious absence.
    mach_timebase_info_data_t timebase = HostTimebase();
    if (timebase.numer == 0 || timebase.denom == 0) {
        fprintf(stderr, "cmio-camera-reader: failed to read the monotonic clock timebase\n");
        return 1;
    }

    AVCaptureDevice *device = [AVCaptureDevice deviceWithUniqueID:deviceUid];
    if (device == nil) {
        fprintf(stderr, "cmio-camera-reader: no AVCaptureDevice with exact unique ID %s\n", deviceUid.UTF8String);
        return 69;
    }
    NSError *error = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
    if (input == nil) {
        fprintf(stderr, "cmio-camera-reader: could not open device input: %s\n",
                error != nil ? error.localizedDescription.UTF8String : "(unknown)");
        return 69;
    }
    AVCaptureSession *session = [[AVCaptureSession alloc] init];
    AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
    output.videoSettings = @{ (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA) };
    output.alwaysDiscardsLateVideoFrames = NO;
    FrameCollector *collector = [[FrameCollector alloc] initWithTarget:frames
                                                             outputDir:outputDir
                                                         writePreviews:!noPreview];
    dispatch_queue_t queue = dispatch_queue_create("com.pico.vcam.reader.frames", DISPATCH_QUEUE_SERIAL);
    [output setSampleBufferDelegate:collector queue:queue];
    if (![session canAddInput:input] || ![session canAddOutput:output]) {
        fprintf(stderr, "cmio-camera-reader: capture session rejected the device input/output\n");
        return 69;
    }
    [session addInput:input];
    [session addOutput:output];

    const uint64_t startNs = MachAbsoluteToNanoseconds(mach_absolute_time());
    [session startRunning];
    // The bounded wait is taken in short slices that re-check the stop flag between them, so a
    // SIGINT/SIGTERM/SIGHUP aborts a long readback instead of being ignored until the timeout.
    const uint64_t deadlineNs = startNs + timeoutMs * NSEC_PER_MSEC;
    long waited = -1;
    while (!gStopRequested) {
        waited = dispatch_semaphore_wait(collector.done,
                                         dispatch_time(DISPATCH_TIME_NOW, (int64_t)kStopPollIntervalNs));
        if (waited == 0) break;
        if (MachAbsoluteToNanoseconds(mach_absolute_time()) >= deadlineNs) break;
    }
    [session stopRunning];
    const uint64_t endNs = MachAbsoluteToNanoseconds(mach_absolute_time());
    [output setSampleBufferDelegate:nil queue:NULL];
    dispatch_sync(queue, ^{});  // barrier: no in-flight callback survives before we read the records

    NSUInteger captured = collector.records.count;
    NSUInteger distinct = collector.distinctRaw.count;
    for (NSString *record in collector.records) {
        fprintf(stdout, "%s\n", record.UTF8String);
    }
    // An interrupted run is a stop, not a timeout; the exit code carries the signal.
    BOOL timedOut = waited != 0 && !gStopRequested;
    fprintf(stdout, "%s\n", ReadbackSummaryRecord(deviceUid,
                                                  outputDir,
                                                  frames,
                                                  captured,
                                                  distinct,
                                                  collector.droppedFrames,
                                                  MillisecondsForNanoseconds(endNs - startNs),
                                                  timedOut,
                                                  noPreview).UTF8String);
    fflush(stdout);

    int code = AvfExitCode(captured, distinct, frames);
    if (code != 0) return code;
    return NormalizeExitCodeForStopRequest(0, gStopRequested);
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
        if (options.authorizationOnly) {
            return EmitAuthorization();
        }
        if (options.avfoundationReadback) {
            return RunAvfReadback(options.deviceUid,
                                  options.outputDir,
                                  options.frames,
                                  options.timeoutMs,
                                  options.noPreview);
        }

        fprintf(stderr, "cmio-camera-reader: no mode selected\n");
        return 64;
    }
}
