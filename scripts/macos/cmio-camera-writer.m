#import <Foundation/Foundation.h>

#include <CommonCrypto/CommonDigest.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreMediaIO/CoreMediaIO.h>
#include <CoreMediaIO/CMIOSampleBuffer.h>
#include <CoreVideo/CoreVideo.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach/mach_time.h>
#include <math.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const size_t kRequiredWidth = 1280;
static const size_t kRequiredHeight = 720;
static const OSType kRequiredPixelFormat = kCVPixelFormatType_32BGRA;
static const double kRequiredFrameRate = 60.0;
static const UInt32 kRequiredQueueSize = 1;
static const UInt32 kMaximumObjectIDs = 4096;
static const int32_t kMaximumCopiedQueueCapacity = 1024;
static const NSUInteger kMaximumFrames = 16;
static const NSUInteger kMaximumManifestBytes = 1024 * 1024;
static const uint64_t kTicksPerSourceFrame = 60;
static const uint64_t kMinimumTicksPerSourceFrame = 1;
static const uint64_t kMaximumTicksPerSourceFrame = 60;
static NSString *const kRequiredDeviceName = @"Immersed Camera";
static NSString *const kRequiredStreamName = @"ImmersedCamera.Video.Sink";
static NSString *const kTestCardKind = @"pico-vcam-test-card-sequence";
static NSString *const kFixedPoseKind = @"pico-vcam-fixed-pose-sequence";

// An enum, not a `static const NSUInteger`: C requires a constant expression for a file-scope
// array bound, and a const object is not one.
enum { kMaximumEnqueueRecords = 4096 };

static volatile sig_atomic_t gStopRequested = 0;

typedef struct {
    _Atomic uint64_t scheduled;
    _Atomic uint64_t enqueued;
    _Atomic uint64_t removed;
    // backpressured stays the total of the four named causes below so existing consumers and
    // previously captured statistics keep the same meaning.
    _Atomic uint64_t backpressured;
    _Atomic uint64_t dropInFlight;
    _Atomic uint64_t dropQueueNonEmpty;
    _Atomic uint64_t dropCasLost;
    _Atomic uint64_t dropQueueFull;
    _Atomic uintptr_t inFlightToken;
    _Atomic uint32_t callbackViolation;
} ProducerState;

// The CMIO extension owns callback scheduling. Process-lifetime storage keeps refCon valid because
// successful stop and callback unregistration are not documented consumer/callback joins.
static ProducerState gProducerState;

typedef struct {
    CMIODeviceID deviceID;
    CMIOStreamID streamID;
    CMVideoFormatDescriptionRef formatDescription;
    Float64 frameRate;
    UInt32 queueSize;
    UInt32 startupBuffers;
} Sink;

typedef struct {
    __strong NSString *deviceUid;
    __strong NSString *manifestPath;
    __strong NSString *expectedManifestSha256;
    size_t width;
    size_t height;
    __strong NSString *pixelFormat;
    uint64_t ticksPerSourceFrame;
    BOOL probeOnly;
    BOOL help;
} Options;

static void HandleSignal(int signalNumber) {
    gStopRequested = (sig_atomic_t)signalNumber;
}

static int NormalizeExitCodeForStopRequest(int exitCode, sig_atomic_t stopSignal) {
    return stopSignal > 0 && exitCode == 0 ? 128 + (int)stopSignal : exitCode;
}

static BOOL IsSHA256(NSString *value);

static BOOL InstallSignalHandlers(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = HandleSignal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) != 0 ||
        sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGHUP, &action, NULL) != 0) {
        fprintf(stderr, "cmio-camera-writer: failed to install shutdown signal handlers: %s\n", strerror(errno));
        return NO;
    }

    struct sigaction ignorePipe;
    memset(&ignorePipe, 0, sizeof(ignorePipe));
    ignorePipe.sa_handler = SIG_IGN;
    sigemptyset(&ignorePipe.sa_mask);
    if (sigaction(SIGPIPE, &ignorePipe, NULL) != 0) {
        fprintf(stderr, "cmio-camera-writer: failed to ignore SIGPIPE: %s\n", strerror(errno));
        return NO;
    }
    return YES;
}

static void PrintUsage(FILE *stream) {
    fprintf(stream,
            "Usage:\n"
            "  cmio-camera-writer --device-uid UUID --width 1280 --height 720\n"
            "      --pixel-format BGRA --manifest PATH\n"
            "      --expected-manifest-sha256 LOWERCASE_HEX\n"
            "      [--ticks-per-source-frame 1..60]\n"
            "  cmio-camera-writer --probe-only --device-uid UUID --width 1280\n"
            "      --height 720 --pixel-format BGRA\n"
            "  cmio-camera-writer --help\n"
            "\n"
            "Streams verified sibling frame-%%03d.bgra files through the exact public\n"
            "CoreMediaIO sink. --probe-only performs property reads only: it does not\n"
            "copy the stream queue, start the stream, enqueue a frame, or mutate CMIO.\n"
            "--ticks-per-source-frame sets how many 60 Hz stream ticks each source\n"
            "image is held for (default 60, i.e. one image per second).\n");
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
                fprintf(stderr, "cmio-camera-writer: duplicate argument --help\n");
                return NO;
            }
            [seen addObject:argument];
            options->help = YES;
            continue;
        }
        if ([argument isEqualToString:@"--probe-only"]) {
            if ([seen containsObject:argument]) {
                fprintf(stderr, "cmio-camera-writer: duplicate argument --probe-only\n");
                return NO;
            }
            [seen addObject:argument];
            options->probeOnly = YES;
            continue;
        }

        BOOL known = [argument isEqualToString:@"--device-uid"] ||
                     [argument isEqualToString:@"--width"] ||
                     [argument isEqualToString:@"--height"] ||
                     [argument isEqualToString:@"--pixel-format"] ||
                     [argument isEqualToString:@"--manifest"] ||
                     [argument isEqualToString:@"--expected-manifest-sha256"] ||
                     [argument isEqualToString:@"--ticks-per-source-frame"];
        if (!known) {
            fprintf(stderr, "cmio-camera-writer: unknown argument: %s\n", argv[index]);
            return NO;
        }
        if ([seen containsObject:argument]) {
            fprintf(stderr, "cmio-camera-writer: duplicate argument: %s\n", argv[index]);
            return NO;
        }
        [seen addObject:argument];
        if (index + 1 >= argc) {
            fprintf(stderr, "cmio-camera-writer: missing value for %s\n", argv[index]);
            return NO;
        }
        NSString *value = [NSString stringWithUTF8String:argv[index + 1]];
        if ([value hasPrefix:@"--"]) {
            fprintf(stderr, "cmio-camera-writer: missing value for %s\n", argv[index]);
            return NO;
        }
        index += 1;

        if ([argument isEqualToString:@"--device-uid"]) options->deviceUid = value;
        else if ([argument isEqualToString:@"--manifest"]) options->manifestPath = value;
        else if ([argument isEqualToString:@"--expected-manifest-sha256"]) options->expectedManifestSha256 = value;
        else if ([argument isEqualToString:@"--pixel-format"]) options->pixelFormat = value;
        else if ([argument isEqualToString:@"--width"] && !ParseSize(value, &options->width)) {
            fprintf(stderr, "cmio-camera-writer: --width must be a positive decimal integer\n");
            return NO;
        } else if ([argument isEqualToString:@"--height"] && !ParseSize(value, &options->height)) {
            fprintf(stderr, "cmio-camera-writer: --height must be a positive decimal integer\n");
            return NO;
        } else if ([argument isEqualToString:@"--ticks-per-source-frame"]) {
            size_t parsedTicks = 0;
            if (!ParseSize(value, &parsedTicks) ||
                (uint64_t)parsedTicks < kMinimumTicksPerSourceFrame ||
                (uint64_t)parsedTicks > kMaximumTicksPerSourceFrame) {
                fprintf(stderr, "cmio-camera-writer: --ticks-per-source-frame must be a decimal integer in 1..60\n");
                return NO;
            }
            options->ticksPerSourceFrame = (uint64_t)parsedTicks;
        }
    }

    if (options->help) {
        if (argc != 2) {
            fprintf(stderr, "cmio-camera-writer: --help must be used alone\n");
            return NO;
        }
        return YES;
    }
    if (options->deviceUid.length == 0 || [[NSUUID alloc] initWithUUIDString:options->deviceUid] == nil) {
        fprintf(stderr, "cmio-camera-writer: --device-uid must be a non-empty UUID\n");
        return NO;
    }
    if (options->width != kRequiredWidth || options->height != kRequiredHeight ||
        ![options->pixelFormat isEqualToString:@"BGRA"]) {
        fprintf(stderr, "cmio-camera-writer: exact format required: 1280x720 BGRA\n");
        return NO;
    }
    if (options->probeOnly) {
        if (options->manifestPath.length > 0 || options->expectedManifestSha256.length > 0 ||
            options->ticksPerSourceFrame != 0) {
            fprintf(stderr, "cmio-camera-writer: --probe-only cannot be combined with producer arguments\n");
            return NO;
        }
    } else {
        if (options->manifestPath.length == 0) {
            fprintf(stderr, "cmio-camera-writer: --manifest PATH is required unless --probe-only is used\n");
            return NO;
        }
        if (!IsSHA256(options->expectedManifestSha256)) {
            fprintf(stderr, "cmio-camera-writer: --expected-manifest-sha256 must be exactly 64 lowercase hex characters\n");
            return NO;
        }
        // `Options options = {0}` makes 0 mean "not supplied"; the parser never accepts 0.
        if (options->ticksPerSourceFrame == 0) options->ticksPerSourceFrame = kTicksPerSourceFrame;
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
    fprintf(stderr, "cmio-camera-writer: %s failed: OSStatus %d", operation.UTF8String, (int)status);
    if (IsPrintableFourCC(raw)) {
        fprintf(stderr, " ('%c%c%c%c')",
                (int)((raw >> 24) & 0xffu), (int)((raw >> 16) & 0xffu),
                (int)((raw >> 8) & 0xffu), (int)(raw & 0xffu));
    } else {
        fprintf(stderr, " (0x%08x)", raw);
    }
    fputc('\n', stderr);
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

static BOOL ReadProperty(CMIOObjectID objectID,
                         CMIOObjectPropertySelector selector,
                         CMIOObjectPropertyScope scope,
                         void *value,
                         UInt32 expectedSize,
                         NSString *label) {
    CMIOObjectPropertyAddress address = PropertyAddress(selector, scope);
    if (!CMIOObjectHasProperty(objectID, &address)) {
        fprintf(stderr, "cmio-camera-writer: required property absent: %s\n", label.UTF8String);
        return NO;
    }
    UInt32 size = 0;
    OSStatus status = CMIOObjectGetPropertyDataSize(objectID, &address, 0, NULL, &size);
    if (status != noErr) {
        PrintOSStatus([NSString stringWithFormat:@"read %@ size", label], status);
        return NO;
    }
    if (size != expectedSize) {
        fprintf(stderr, "cmio-camera-writer: %s has size %u, expected %u\n",
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
        fprintf(stderr, "cmio-camera-writer: %s returned %u bytes, expected %u\n",
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
        fprintf(stderr, "cmio-camera-writer: %s did not return a CFString\n", label.UTF8String);
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
        fprintf(stderr, "cmio-camera-writer: required property absent: %s\n", label.UTF8String);
        return NO;
    }
    UInt32 size = 0;
    OSStatus status = CMIOObjectGetPropertyDataSize(objectID, &address, 0, NULL, &size);
    if (status != noErr) {
        PrintOSStatus([NSString stringWithFormat:@"read %@ size", label], status);
        return NO;
    }
    if (size == 0 || size % sizeof(CMIOObjectID) != 0 ||
        size > kMaximumObjectIDs * sizeof(CMIOObjectID)) {
        fprintf(stderr, "cmio-camera-writer: %s returned invalid byte size %u\n", label.UTF8String, (unsigned)size);
        return NO;
    }
    CMIOObjectID *ids = calloc(1, size);
    if (ids == NULL) {
        fprintf(stderr, "cmio-camera-writer: allocation failed for %s\n", label.UTF8String);
        return NO;
    }
    UInt32 returnedSize = size;
    status = CMIOObjectGetPropertyData(objectID, &address, 0, NULL, size, &returnedSize, ids);
    if (status != noErr) {
        PrintOSStatus([NSString stringWithFormat:@"read %@", label], status);
        free(ids);
        return NO;
    }
    if (returnedSize == 0 || returnedSize > size || returnedSize % sizeof(CMIOObjectID) != 0) {
        fprintf(stderr, "cmio-camera-writer: %s returned invalid data byte size %u\n",
                label.UTF8String, (unsigned)returnedSize);
        free(ids);
        return NO;
    }
    *idsOut = ids;
    *countOut = returnedSize / (UInt32)sizeof(CMIOObjectID);
    return YES;
}

static NSString *FourCCString(OSType value) {
    uint32_t raw = (uint32_t)value;
    if (!IsPrintableFourCC(raw)) return [NSString stringWithFormat:@"0x%08x", raw];
    return [NSString stringWithFormat:@"%c%c%c%c",
            (int)((raw >> 24) & 0xffu), (int)((raw >> 16) & 0xffu),
            (int)((raw >> 8) & 0xffu), (int)(raw & 0xffu)];
}

static BOOL DiscoverSink(NSString *expectedUid, Sink *sink) {
    memset(sink, 0, sizeof(*sink));
    CMIOObjectID *deviceIDs = NULL;
    UInt32 deviceCount = 0;
    if (!CopyObjectIDs(kCMIOObjectSystemObject,
                       kCMIOHardwarePropertyDevices,
                       kCMIOObjectPropertyScopeGlobal,
                       @"CMIO device list",
                       &deviceIDs,
                       &deviceCount)) return NO;

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
        fprintf(stderr, "cmio-camera-writer: exact device UID %s matched %u CMIO devices; expected 1\n",
                expectedUid.UTF8String, (unsigned)matchedCount);
        return NO;
    }

    NSString *deviceName = CopyStringProperty(matchedDevice,
                                              kCMIOObjectPropertyName,
                                              kCMIOObjectPropertyScopeGlobal,
                                              @"device name");
    if (deviceName == nil || ![deviceName isEqualToString:kRequiredDeviceName]) {
        const char *actualName = deviceName == nil ? "(null)" : deviceName.UTF8String;
        fprintf(stderr, "cmio-camera-writer: device UID %s has name '%s'; required '%s'\n",
                expectedUid.UTF8String, actualName, kRequiredDeviceName.UTF8String);
        return NO;
    }

    CMIOObjectID *streamIDs = NULL;
    UInt32 streamCount = 0;
    if (!CopyObjectIDs(matchedDevice,
                       kCMIODevicePropertyStreams,
                       kCMIODevicePropertyScopeOutput,
                       @"output-scope stream list",
                       &streamIDs,
                       &streamCount)) return NO;

    CMIOStreamID matchedStream = kCMIOStreamUnknown;
    UInt32 matchedStreamCount = 0;
    for (UInt32 index = 0; index < streamCount; index += 1) {
        NSString *streamName = CopyStringProperty(streamIDs[index],
                                                  kCMIOObjectPropertyName,
                                                  kCMIOObjectPropertyScopeGlobal,
                                                  @"stream name");
        if (streamName != nil && [streamName isEqualToString:kRequiredStreamName]) {
            matchedStream = streamIDs[index];
            matchedStreamCount += 1;
        }
    }
    free(streamIDs);
    if (matchedStreamCount != 1) {
        fprintf(stderr, "cmio-camera-writer: output stream '%s' matched %u streams; expected 1\n",
                kRequiredStreamName.UTF8String, (unsigned)matchedStreamCount);
        return NO;
    }

    UInt32 direction = UINT32_MAX;
    if (!ReadProperty(matchedStream,
                      kCMIOStreamPropertyDirection,
                      kCMIOObjectPropertyScopeGlobal,
                      &direction,
                      sizeof(direction),
                      @"stream direction")) return NO;
    if (direction != 0) {
        fprintf(stderr, "cmio-camera-writer: stream direction is %u; required output direction 0\n",
                (unsigned)direction);
        return NO;
    }

    CMFormatDescriptionRef formatDescription = NULL;
    if (!ReadProperty(matchedStream,
                      kCMIOStreamPropertyFormatDescription,
                      kCMIOObjectPropertyScopeGlobal,
                      &formatDescription,
                      sizeof(formatDescription),
                      @"current stream format")) return NO;
    if (formatDescription == NULL ||
        CFGetTypeID(formatDescription) != CMFormatDescriptionGetTypeID() ||
        CMFormatDescriptionGetMediaType(formatDescription) != kCMMediaType_Video) {
        fprintf(stderr, "cmio-camera-writer: current stream format is not video\n");
        if (formatDescription != NULL) CFRelease(formatDescription);
        return NO;
    }
    OSType subtype = CMFormatDescriptionGetMediaSubType(formatDescription);
    CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription);
    if (subtype != kRequiredPixelFormat || dimensions.width != (int32_t)kRequiredWidth ||
        dimensions.height != (int32_t)kRequiredHeight) {
        NSString *subtypeText = FourCCString(subtype);
        fprintf(stderr, "cmio-camera-writer: current format is %dx%d %s; required 1280x720 BGRA\n",
                dimensions.width, dimensions.height, subtypeText.UTF8String);
        CFRelease(formatDescription);
        return NO;
    }

    Float64 frameRate = 0.0;
    if (!ReadProperty(matchedStream,
                      kCMIOStreamPropertyFrameRate,
                      kCMIOObjectPropertyScopeGlobal,
                      &frameRate,
                      sizeof(frameRate),
                      @"current stream frame rate")) {
        CFRelease(formatDescription);
        return NO;
    }
    if (!isfinite(frameRate) || frameRate < kRequiredFrameRate - 0.0001 ||
        frameRate > kRequiredFrameRate + 0.0001) {
        fprintf(stderr, "cmio-camera-writer: current frame rate is %.9g; required 60\n", frameRate);
        CFRelease(formatDescription);
        return NO;
    }

    UInt32 queueSize = 0;
    if (!ReadProperty(matchedStream,
                      kCMIOStreamPropertyOutputBufferQueueSize,
                      kCMIOObjectPropertyScopeGlobal,
                      &queueSize,
                      sizeof(queueSize),
                      @"output queue size")) {
        CFRelease(formatDescription);
        return NO;
    }
    UInt32 startupBuffers = 0;
    if (!ReadProperty(matchedStream,
                      kCMIOStreamPropertyOutputBuffersRequiredForStartup,
                      kCMIOObjectPropertyScopeGlobal,
                      &startupBuffers,
                      sizeof(startupBuffers),
                      @"output buffers required for startup")) {
        CFRelease(formatDescription);
        return NO;
    }
    if (queueSize != kRequiredQueueSize || startupBuffers != kRequiredQueueSize) {
        fprintf(stderr,
                "cmio-camera-writer: sink queue contract is size=%u startup=%u; required read-only values are 1 and 1\n",
                (unsigned)queueSize, (unsigned)startupBuffers);
        CFRelease(formatDescription);
        return NO;
    }

    sink->deviceID = matchedDevice;
    sink->streamID = matchedStream;
    sink->formatDescription = (CMVideoFormatDescriptionRef)formatDescription;
    sink->frameRate = frameRate;
    sink->queueSize = queueSize;
    sink->startupBuffers = startupBuffers;
    return YES;
}

static BOOL IsJSONInteger(id value, long long minimum, long long maximum, long long *integerOut) {
    if (![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
        return NO;
    }
    double number = [value doubleValue];
    long long integer = [value longLongValue];
    if (!isfinite(number) || number != (double)integer || integer < minimum || integer > maximum) return NO;
    if (integerOut != NULL) *integerOut = integer;
    return YES;
}

static BOOL IsSHA256(NSString *value) {
    if (![value isKindOfClass:[NSString class]] || value.length != CC_SHA256_DIGEST_LENGTH * 2) return NO;
    NSCharacterSet *notHex = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
    return [value rangeOfCharacterFromSet:notHex].location == NSNotFound;
}

static NSString *SHA256Hex(NSData *data) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    char encoded[CC_SHA256_DIGEST_LENGTH * 2 + 1];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
        snprintf(encoded + index * 2, 3, "%02x", digest[index]);
    }
    encoded[CC_SHA256_DIGEST_LENGTH * 2] = '\0';
    return [NSString stringWithUTF8String:encoded];
}

static BOOL ValidateCounterRegion(id value) {
    if (![value isKindOfClass:[NSDictionary class]]) return NO;
    NSDictionary *region = value;
    long long x = 0, y = 0, width = 0, height = 0;
    if (!IsJSONInteger(region[@"x"], 0, (long long)kRequiredWidth - 1, &x) ||
        !IsJSONInteger(region[@"y"], 0, (long long)kRequiredHeight - 1, &y) ||
        !IsJSONInteger(region[@"width"], 1, (long long)kRequiredWidth, &width) ||
        !IsJSONInteger(region[@"height"], 1, (long long)kRequiredHeight, &height)) return NO;
    return x + width <= (long long)kRequiredWidth && y + height <= (long long)kRequiredHeight;
}

static BOOL IsFiniteJSONNumber(id value) {
    if (![value isKindOfClass:[NSNumber class]] ||
        CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
        return NO;
    }
    return isfinite([value doubleValue]) ? YES : NO;
}

static BOOL IsPositiveFiniteJSONNumber(id value) {
    return IsFiniteJSONNumber(value) && [value doubleValue] > 0.0;
}

static BOOL IsNonEmptyJSONString(id value) {
    return [value isKindOfClass:[NSString class]] && ((NSString *)value).length > 0;
}

static BOOL IsFiniteVector3(id value, const char *label) {
    NSArray *vector = [value isKindOfClass:[NSArray class]] ? (NSArray *)value : nil;
    if (vector == nil || vector.count != 3) {
        fprintf(stderr, "cmio-camera-writer: provenance %s must be exactly three finite numbers\n", label);
        return NO;
    }
    for (id element in vector) {
        if (!IsFiniteJSONNumber(element)) {
            fprintf(stderr, "cmio-camera-writer: provenance %s must be exactly three finite numbers\n", label);
            return NO;
        }
    }
    return YES;
}

// Presence, type, and range only. The writer deliberately does not attempt semantic verification —
// it never opens splatPath or renderer.script to confirm the recorded digests, because a producer
// that must stay fail-closed and offline cannot be made to depend on files it does not own. What
// this check guarantees is that a fixed-pose manifest cannot reach a live camera sink without a
// complete, well-formed record of which world, pose, intrinsics, renderer, and base frame the
// pixels came from. Every failure names `provenance` so the exit-65 diagnostic is unambiguous.
static BOOL ValidateFixedPoseProvenance(id value) {
    if (![value isKindOfClass:[NSDictionary class]]) {
        fprintf(stderr, "cmio-camera-writer: fixed-pose manifest provenance is required and must be an object\n");
        return NO;
    }
    NSDictionary *provenance = value;

    NSDictionary *worldModel = [provenance[@"worldModel"] isKindOfClass:[NSDictionary class]]
                                   ? (NSDictionary *)provenance[@"worldModel"]
                                   : nil;
    if (worldModel == nil) {
        fprintf(stderr, "cmio-camera-writer: provenance worldModel must be an object\n");
        return NO;
    }
    if (!IsNonEmptyJSONString(worldModel[@"splatPath"])) {
        fprintf(stderr, "cmio-camera-writer: provenance worldModel.splatPath must be a non-empty string\n");
        return NO;
    }
    if (!IsSHA256(worldModel[@"splatSha256"])) {
        fprintf(stderr, "cmio-camera-writer: provenance worldModel.splatSha256 must be 64 lowercase hex characters\n");
        return NO;
    }
    if (!IsFiniteVector3(worldModel[@"offsetApplied"], "worldModel.offsetApplied")) return NO;

    NSDictionary *pose = [provenance[@"pose"] isKindOfClass:[NSDictionary class]]
                             ? (NSDictionary *)provenance[@"pose"]
                             : nil;
    if (pose == nil) {
        fprintf(stderr, "cmio-camera-writer: provenance pose must be an object\n");
        return NO;
    }
    // `target` is the single canonical orientation encoding: it is what the renderer consumes, and
    // re-verifying it needs no trigonometry. yaw/pitch are rejected outright rather than accepted as
    // an alternative so this stays a flat three-finite-numbers check with exactly one truth.
    if (pose[@"yawDeg"] != nil || pose[@"pitchDeg"] != nil) {
        fprintf(stderr, "cmio-camera-writer: provenance pose must encode orientation as target, not yawDeg/pitchDeg\n");
        return NO;
    }
    if (!IsFiniteVector3(pose[@"position"], "pose.position")) return NO;
    if (!IsFiniteVector3(pose[@"target"], "pose.target")) return NO;
    if (![pose[@"frame"] isEqual:@"app"]) {
        fprintf(stderr, "cmio-camera-writer: provenance pose.frame must be exactly \"app\"\n");
        return NO;
    }

    NSDictionary *intrinsics = [provenance[@"intrinsics"] isKindOfClass:[NSDictionary class]]
                                   ? (NSDictionary *)provenance[@"intrinsics"]
                                   : nil;
    if (intrinsics == nil) {
        fprintf(stderr, "cmio-camera-writer: provenance intrinsics must be an object\n");
        return NO;
    }
    for (NSString *key in @[@"f", @"cx", @"cy", @"fovDeg"]) {
        if (!IsPositiveFiniteJSONNumber(intrinsics[key])) {
            fprintf(stderr, "cmio-camera-writer: provenance intrinsics.%s must be a positive finite number\n",
                    key.UTF8String);
            return NO;
        }
    }

    NSDictionary *renderer = [provenance[@"renderer"] isKindOfClass:[NSDictionary class]]
                                 ? (NSDictionary *)provenance[@"renderer"]
                                 : nil;
    if (renderer == nil) {
        fprintf(stderr, "cmio-camera-writer: provenance renderer must be an object\n");
        return NO;
    }
    if (!IsNonEmptyJSONString(renderer[@"script"])) {
        fprintf(stderr, "cmio-camera-writer: provenance renderer.script must be a non-empty string\n");
        return NO;
    }
    if (!IsSHA256(renderer[@"scriptSha256"])) {
        fprintf(stderr, "cmio-camera-writer: provenance renderer.scriptSha256 must be 64 lowercase hex characters\n");
        return NO;
    }
    if (!IsJSONInteger(renderer[@"pointsRendered"], 0, LLONG_MAX, NULL)) {
        fprintf(stderr, "cmio-camera-writer: provenance renderer.pointsRendered must be a nonnegative integer\n");
        return NO;
    }

    if (!IsSHA256(provenance[@"baseFrameSha256"])) {
        fprintf(stderr, "cmio-camera-writer: provenance baseFrameSha256 must be 64 lowercase hex characters\n");
        return NO;
    }
    return YES;
}

static BOOL SameFileTimes(const struct stat *left, const struct stat *right) {
    return left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
           left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
           left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
           left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static NSData *ReadRegularFileNoFollow(NSString *path,
                                       off_t minimumBytes,
                                       off_t maximumBytes,
                                       NSString *label) {
    const char *fileSystemPath = path.fileSystemRepresentation;
    int descriptor = open(fileSystemPath, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (descriptor < 0) {
        fprintf(stderr, "cmio-camera-writer: cannot open %s without following symlinks: %s: %s\n",
                label.UTF8String, fileSystemPath, strerror(errno));
        return nil;
    }

    struct stat before;
    if (fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode) ||
        before.st_size < minimumBytes || before.st_size > maximumBytes) {
        fprintf(stderr, "cmio-camera-writer: %s must be a regular file with %lld..%lld bytes: %s\n",
                label.UTF8String, (long long)minimumBytes, (long long)maximumBytes, fileSystemPath);
        close(descriptor);
        return nil;
    }
    int descriptorFlags = fcntl(descriptor, F_GETFL);
    if (descriptorFlags < 0 || fcntl(descriptor, F_SETFL, descriptorFlags & ~O_NONBLOCK) != 0) {
        fprintf(stderr, "cmio-camera-writer: cannot configure bounded read for %s: %s\n",
                label.UTF8String, strerror(errno));
        close(descriptor);
        return nil;
    }

    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)before.st_size];
    uint8_t *destination = data.mutableBytes;
    size_t remaining = (size_t)before.st_size;
    while (remaining > 0) {
        ssize_t count = read(descriptor, destination, remaining);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) {
            fprintf(stderr, "cmio-camera-writer: short read for %s: %s\n", label.UTF8String, fileSystemPath);
            close(descriptor);
            return nil;
        }
        destination += (size_t)count;
        remaining -= (size_t)count;
    }

    struct stat after;
    if (fstat(descriptor, &after) != 0 || before.st_dev != after.st_dev ||
        before.st_ino != after.st_ino || before.st_size != after.st_size ||
        !SameFileTimes(&before, &after)) {
        fprintf(stderr, "cmio-camera-writer: %s changed while it was being read: %s\n",
                label.UTF8String, fileSystemPath);
        close(descriptor);
        return nil;
    }
    if (close(descriptor) != 0) {
        fprintf(stderr, "cmio-camera-writer: failed to close %s: %s\n", label.UTF8String, strerror(errno));
        return nil;
    }
    return data;
}

// frameHashesOut receives the validated lowercase per-frame SHA-256 strings in frame order, so the
// tick loop can label each enqueue without rehashing 3.6 MB per frame.
static NSArray<NSData *> *LoadAndValidateFrames(NSString *manifestPath,
                                                NSString *expectedManifestSha256,
                                                NSArray<NSString *> **frameHashesOut) {
    *frameHashesOut = nil;
    NSData *manifestBytes = ReadRegularFileNoFollow(manifestPath, 1, (off_t)kMaximumManifestBytes, @"manifest");
    if (manifestBytes == nil) return nil;
    NSString *actualManifestSha256 = SHA256Hex(manifestBytes);
    if (![actualManifestSha256 isEqualToString:expectedManifestSha256]) {
        fprintf(stderr, "cmio-camera-writer: manifest SHA-256 mismatch: expected %s, got %s\n",
                expectedManifestSha256.UTF8String, actualManifestSha256.UTF8String);
        return nil;
    }
    NSError *jsonError = nil;
    id decoded = [NSJSONSerialization JSONObjectWithData:manifestBytes options:0 error:&jsonError];
    if (![decoded isKindOfClass:[NSDictionary class]]) {
        const char *description = jsonError == nil ? "invalid JSON" : jsonError.localizedDescription.UTF8String;
        fprintf(stderr, "cmio-camera-writer: manifest JSON must be an object: %s\n", description);
        return nil;
    }
    NSDictionary *manifest = decoded;
    long long schemaVersion = 0, width = 0, height = 0, frameBytes = 0;
    if (!IsJSONInteger(manifest[@"schemaVersion"], 1, 1, &schemaVersion) ||
        !IsJSONInteger(manifest[@"width"], (long long)kRequiredWidth, (long long)kRequiredWidth, &width) ||
        !IsJSONInteger(manifest[@"height"], (long long)kRequiredHeight, (long long)kRequiredHeight, &height) ||
        !IsJSONInteger(manifest[@"frameBytes"],
                       (long long)(kRequiredWidth * kRequiredHeight * 4),
                       (long long)(kRequiredWidth * kRequiredHeight * 4),
                       &frameBytes) ||
        ![manifest[@"pixelFormat"] isEqual:@"BGRA"]) {
        fprintf(stderr, "cmio-camera-writer: manifest requires schemaVersion 1 and exact 1280x720 BGRA frame geometry\n");
        return nil;
    }
    id kindValue = manifest[@"kind"];
    if (![kindValue isKindOfClass:[NSString class]]) {
        fprintf(stderr, "cmio-camera-writer: manifest kind must be a string\n");
        return nil;
    }
    NSString *kind = kindValue;
    // Exact string equality against a two-entry allowlist. Never a prefix/hasPrefix/regex test: an
    // unrecognized kind must fail closed, and a prefix match would silently admit successors that
    // this writer has never validated.
    BOOL isTestCard = [kind isEqualToString:kTestCardKind];
    BOOL isFixedPose = [kind isEqualToString:kFixedPoseKind];
    if (!isTestCard && !isFixedPose) {
        fprintf(stderr, "cmio-camera-writer: unsupported manifest kind: %s\n",
                [kind isKindOfClass:[NSString class]] ? kind.UTF8String : "(non-string)");
        return nil;
    }
    // Nothing is relaxed for the new kind: both kinds still require the nonce and the in-bounds
    // counterRegion the boundary report's changing-frame rule depends on.
    NSString *nonce = manifest[@"nonce"];
    if (![nonce isKindOfClass:[NSString class]] || nonce.length == 0 || !ValidateCounterRegion(manifest[@"counterRegion"])) {
        fprintf(stderr, "cmio-camera-writer: manifest requires a non-empty nonce and in-bounds counterRegion\n");
        return nil;
    }
    if (isFixedPose && !ValidateFixedPoseProvenance(manifest[@"provenance"])) return nil;

    NSArray *frames = manifest[@"frames"];
    if (![frames isKindOfClass:[NSArray class]] || frames.count == 0 || frames.count > kMaximumFrames) {
        fprintf(stderr, "cmio-camera-writer: manifest frames must contain 1..%u entries\n", (unsigned)kMaximumFrames);
        return nil;
    }

    NSString *directory = [manifestPath stringByDeletingLastPathComponent];
    NSMutableArray<NSData *> *loaded = [NSMutableArray arrayWithCapacity:frames.count];
    NSMutableArray<NSString *> *hashes = [NSMutableArray arrayWithCapacity:frames.count];
    for (NSUInteger index = 0; index < frames.count; index += 1) {
        id entryValue = frames[index];
        if (![entryValue isKindOfClass:[NSDictionary class]]) {
            fprintf(stderr, "cmio-camera-writer: manifest frame %u must be an object\n", (unsigned)index);
            return nil;
        }
        NSDictionary *entry = entryValue;
        long long counter = 0, bytes = 0;
        if (!IsJSONInteger(entry[@"counter"], 0, LLONG_MAX, &counter) ||
            !IsJSONInteger(entry[@"bytes"], frameBytes, frameBytes, &bytes) ||
            !IsSHA256(entry[@"sha256"])) {
            fprintf(stderr, "cmio-camera-writer: manifest frame %u requires nonnegative integer counter, exact bytes, and lowercase SHA-256\n",
                    (unsigned)index);
            return nil;
        }
        NSString *fileName = [NSString stringWithFormat:@"frame-%03lu.bgra", (unsigned long)index];
        NSString *framePath = [directory stringByAppendingPathComponent:fileName];
        NSString *frameLabel = [NSString stringWithFormat:@"frame %u", (unsigned)index];
        NSData *data = ReadRegularFileNoFollow(framePath, (off_t)frameBytes, (off_t)frameBytes, frameLabel);
        if (data == nil) return nil;
        NSString *actualHash = SHA256Hex(data);
        if (![actualHash isEqualToString:entry[@"sha256"]]) {
            fprintf(stderr, "cmio-camera-writer: frame %u SHA-256 mismatch: expected %s, got %s\n",
                    (unsigned)index, [entry[@"sha256"] UTF8String], actualHash.UTF8String);
            return nil;
        }
        [loaded addObject:data];
        [hashes addObject:actualHash];
    }
    *frameHashesOut = [hashes copy];
    return [loaded copy];
}

static void CopyFormatAttachments(CMVideoFormatDescriptionRef formatDescription,
                                  CVPixelBufferRef pixelBuffer) {
    CFDictionaryRef extensions = CMFormatDescriptionGetExtensions(formatDescription);
    CFArrayRef commonKeys = CMVideoFormatDescriptionGetExtensionKeysCommonWithImageBuffers();
    if (extensions == NULL || commonKeys == NULL) return;
    CFIndex count = CFArrayGetCount(commonKeys);
    for (CFIndex index = 0; index < count; index += 1) {
        CFStringRef key = (CFStringRef)CFArrayGetValueAtIndex(commonKeys, index);
        CFTypeRef value = CFDictionaryGetValue(extensions, key);
        if (value != NULL) CVBufferSetAttachment(pixelBuffer, key, value, kCVAttachmentMode_ShouldPropagate);
    }
}

static CMSampleBufferRef CreateSampleBuffer(NSData *frame,
                                            CMVideoFormatDescriptionRef formatDescription,
                                            CMTime presentationTime,
                                            uint64_t sequenceNumber) {
    NSDictionary *attributes = @{
        (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},
        (__bridge NSString *)kCVPixelBufferBytesPerRowAlignmentKey: @(kRequiredWidth * 4),
    };
    CVPixelBufferRef pixelBuffer = NULL;
    CVReturn pixelStatus = CVPixelBufferCreate(kCFAllocatorDefault,
                                               kRequiredWidth,
                                               kRequiredHeight,
                                               kRequiredPixelFormat,
                                               (__bridge CFDictionaryRef)attributes,
                                               &pixelBuffer);
    if (pixelStatus != kCVReturnSuccess || pixelBuffer == NULL) {
        PrintOSStatus(@"create IOSurface-backed pixel buffer", pixelStatus);
        return NULL;
    }
    if (CVPixelBufferGetIOSurface(pixelBuffer) == NULL) {
        fprintf(stderr, "cmio-camera-writer: CoreVideo returned a pixel buffer without an IOSurface\n");
        CVPixelBufferRelease(pixelBuffer);
        return NULL;
    }

    pixelStatus = CVPixelBufferLockBaseAddress(pixelBuffer, 0);
    if (pixelStatus != kCVReturnSuccess) {
        PrintOSStatus(@"lock pixel buffer", pixelStatus);
        CVPixelBufferRelease(pixelBuffer);
        return NULL;
    }
    uint8_t *destination = CVPixelBufferGetBaseAddress(pixelBuffer);
    size_t destinationStride = CVPixelBufferGetBytesPerRow(pixelBuffer);
    const uint8_t *source = frame.bytes;
    size_t sourceStride = kRequiredWidth * 4;
    if (destination == NULL || destinationStride < sourceStride) {
        fprintf(stderr, "cmio-camera-writer: pixel buffer stride %zu cannot hold %zu-byte BGRA rows\n",
                destinationStride, sourceStride);
        CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
        CVPixelBufferRelease(pixelBuffer);
        return NULL;
    }
    for (size_t row = 0; row < kRequiredHeight; row += 1) {
        memcpy(destination + row * destinationStride, source + row * sourceStride, sourceStride);
    }
    pixelStatus = CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
    if (pixelStatus != kCVReturnSuccess) {
        PrintOSStatus(@"unlock pixel buffer", pixelStatus);
        CVPixelBufferRelease(pixelBuffer);
        return NULL;
    }

    CopyFormatAttachments(formatDescription, pixelBuffer);
    if (!CMVideoFormatDescriptionMatchesImageBuffer(formatDescription, pixelBuffer)) {
        fprintf(stderr, "cmio-camera-writer: IOSurface-backed pixel buffer does not match the current stream format description\n");
        CVPixelBufferRelease(pixelBuffer);
        return NULL;
    }
    CMSampleTimingInfo timing = {
        .duration = CMTimeMake(1, 60),
        .presentationTimeStamp = presentationTime,
        .decodeTimeStamp = kCMTimeInvalid,
    };
    CMSampleBufferRef sampleBuffer = NULL;
    OSStatus status = CMIOSampleBufferCreateForImageBuffer(kCFAllocatorDefault,
                                                           pixelBuffer,
                                                           formatDescription,
                                                           &timing,
                                                           sequenceNumber,
                                                           0,
                                                           &sampleBuffer);
    CVPixelBufferRelease(pixelBuffer);
    if (status != noErr || sampleBuffer == NULL) {
        PrintOSStatus(@"create CMIO sample buffer", status);
        if (sampleBuffer != NULL) CFRelease(sampleBuffer);
        return NULL;
    }
    return sampleBuffer;
}

static BOOL RetireExactInFlightToken(ProducerState *state, const void *token) {
    if (token == NULL) {
        atomic_store_explicit(&state->callbackViolation, 1, memory_order_release);
        return NO;
    }
    uintptr_t expectedToken = (uintptr_t)token;
    if (!atomic_compare_exchange_strong_explicit(&state->inFlightToken,
                                                 &expectedToken,
                                                 0,
                                                 memory_order_acq_rel,
                                                 memory_order_acquire)) {
        atomic_store_explicit(&state->callbackViolation, 1, memory_order_release);
        return NO;
    }
    return YES;
}

static void FinalizeEnqueueOwnership(ProducerState *state,
                                     const void *token,
                                     OSStatus enqueueStatus) {
    if (enqueueStatus == noErr) {
        // A successful output enqueue transfers the creator's reference to CoreMediaIO.
        return;
    }
    if (RetireExactInFlightToken(state, token)) {
        CFRelease((CFTypeRef)token);
    }
}

static void QueueAltered(CMIOStreamID streamID, void *token, void *refCon) {
    (void)streamID;
    ProducerState *state = refCon;
    if (!RetireExactInFlightToken(state, token)) return;
    // For output streams, CoreMediaIO invokes this callback from CopySampleBuffer and then
    // releases the removed CMSampleBuffer itself. The token is a borrowed removal notification;
    // releasing it here double-finalizes the sample and its pixel-buffer backing.
    atomic_fetch_add_explicit(&state->removed, 1, memory_order_relaxed);
}

static BOOL EmitReady(NSString *deviceUid,
                      NSString *manifestSha256,
                      const Sink *sink,
                      int32_t copiedQueueCapacity) {
    int result = fprintf(stdout,
                         "{\"event\":\"ready\",\"deviceUid\":\"%s\",\"width\":1280,\"height\":720,"
                         "\"pixelFormat\":\"BGRA\",\"manifestSha256\":\"%s\","
                         "\"configuredQueueSize\":%u,\"startupBuffers\":%u,"
                         "\"copiedQueueCapacity\":%d,\"effectiveMaxInFlight\":1}\n",
                         deviceUid.UTF8String,
                         manifestSha256.UTF8String,
                         (unsigned)sink->queueSize,
                         (unsigned)sink->startupBuffers,
                         copiedQueueCapacity);
    return result >= 0 && fflush(stdout) == 0;
}

static BOOL EmitProbe(NSString *deviceUid, const Sink *sink) {
    int result = fprintf(stdout,
                         "{\"event\":\"probe\",\"ok\":true,\"deviceUid\":\"%s\",\"deviceName\":\"Immersed Camera\","
                         "\"streamName\":\"ImmersedCamera.Video.Sink\",\"direction\":0,\"width\":1280,\"height\":720,"
                         "\"pixelFormat\":\"BGRA\",\"frameRate\":%.9g,\"queueSize\":%u,\"startupBuffers\":%u,"
                         "\"readOnly\":true}\n",
                         deviceUid.UTF8String,
                         sink->frameRate,
                         (unsigned)sink->queueSize,
                         (unsigned)sink->startupBuffers);
    return result >= 0 && fflush(stdout) == 0;
}

typedef struct {
    uint64_t sequence;
    uint64_t frameIndex;
    uint64_t hostTimeNs;
    double presentationTimeMs;
    char sha256[CC_SHA256_DIGEST_LENGTH * 2 + 1];
} EnqueueRecord;

// Written only by the single producer tick loop, read only after that loop exits.
static EnqueueRecord gEnqueueRecords[kMaximumEnqueueRecords];
static NSUInteger gEnqueueRecordCount = 0;
static BOOL gEnqueueRecordsTruncated = NO;

// Bounded and never wrapped. Wrapping would delete the OLDEST records, which are exactly the ones
// a "latest enqueue at or before the observation" correlation depends on, so an overflow stops
// recording and reports itself instead of silently corrupting the timeline.
static void RecordEnqueue(uint64_t sequence,
                          uint64_t frameIndex,
                          uint64_t hostTimeNs,
                          double presentationTimeMs,
                          NSString *sha256) {
    if (gEnqueueRecordCount >= (NSUInteger)kMaximumEnqueueRecords) {
        gEnqueueRecordsTruncated = YES;
        return;
    }
    EnqueueRecord *record = &gEnqueueRecords[gEnqueueRecordCount];
    record->sequence = sequence;
    record->frameIndex = frameIndex;
    record->hostTimeNs = hostTimeNs;
    record->presentationTimeMs = presentationTimeMs;
    const char *encoded = sha256.UTF8String;
    if (encoded == NULL) encoded = "";
    strncpy(record->sha256, encoded, sizeof(record->sha256) - 1);
    record->sha256[sizeof(record->sha256) - 1] = '\0';
    gEnqueueRecordCount += 1;
}

static BOOL FlushEnqueueRecords(void) {
    for (NSUInteger index = 0; index < gEnqueueRecordCount; index += 1) {
        const EnqueueRecord *record = &gEnqueueRecords[index];
        int result = fprintf(stdout,
                             "{\"event\":\"enqueue\",\"sequence\":%llu,\"frameIndex\":%llu,\"sha256\":\"%s\","
                             "\"hostTimeNs\":%llu,\"presentationTimeMs\":%.4f}\n",
                             (unsigned long long)record->sequence,
                             (unsigned long long)record->frameIndex,
                             record->sha256,
                             (unsigned long long)record->hostTimeNs,
                             record->presentationTimeMs);
        if (result < 0) return NO;
    }
    return fflush(stdout) == 0;
}

static BOOL EmitStats(NSString *phase,
                      const ProducerState *state,
                      BOOL consumerQuiescenceProven) {
    uint64_t scheduled = atomic_load_explicit(&state->scheduled, memory_order_relaxed);
    uint64_t enqueued = atomic_load_explicit(&state->enqueued, memory_order_relaxed);
    uint64_t removed = atomic_load_explicit(&state->removed, memory_order_relaxed);
    uint64_t backpressured = atomic_load_explicit(&state->backpressured, memory_order_relaxed);
    uint64_t dropInFlight = atomic_load_explicit(&state->dropInFlight, memory_order_relaxed);
    uint64_t dropQueueNonEmpty = atomic_load_explicit(&state->dropQueueNonEmpty, memory_order_relaxed);
    uint64_t dropCasLost = atomic_load_explicit(&state->dropCasLost, memory_order_relaxed);
    uint64_t dropQueueFull = atomic_load_explicit(&state->dropQueueFull, memory_order_relaxed);
    int result = fprintf(stdout,
                         "{\"event\":\"stats\",\"phase\":\"%s\",\"scheduled\":%llu,\"enqueued\":%llu,"
                         "\"removed\":%llu,\"backpressured\":%llu,"
                         "\"dropInFlight\":%llu,\"dropQueueNonEmpty\":%llu,\"dropCasLost\":%llu,"
                         "\"dropQueueFull\":%llu,\"recordsTruncated\":%s,\"callbackViolation\":%u,"
                         "\"consumerQuiescenceProven\":%s}\n",
                         phase.UTF8String,
                         (unsigned long long)scheduled,
                         (unsigned long long)enqueued,
                         (unsigned long long)removed,
                         (unsigned long long)backpressured,
                         (unsigned long long)dropInFlight,
                         (unsigned long long)dropQueueNonEmpty,
                         (unsigned long long)dropCasLost,
                         (unsigned long long)dropQueueFull,
                         gEnqueueRecordsTruncated ? "true" : "false",
                         (unsigned)atomic_load_explicit(&state->callbackViolation, memory_order_acquire),
                         consumerQuiescenceProven ? "true" : "false");
    return result >= 0 && fflush(stdout) == 0;
}

static uint64_t MachTicksForNanoseconds(uint64_t nanoseconds, mach_timebase_info_data_t timebase) {
    __uint128_t scaled = (__uint128_t)nanoseconds * timebase.denom;
    return (uint64_t)(scaled / timebase.numer);
}

static uint64_t NanosecondsForMachTicks(uint64_t ticks, mach_timebase_info_data_t timebase) {
    __uint128_t scaled = (__uint128_t)ticks * timebase.numer;
    return (uint64_t)(scaled / timebase.denom);
}

static void ReclaimStoppedQueue(CMSimpleQueueRef queue,
                                ProducerState *state,
                                BOOL consumerQuiescenceProven) {
    if (queue == NULL || !consumerQuiescenceProven) return;
    const void *token = NULL;
    while ((token = CMSimpleQueueDequeue(queue)) != NULL) {
        if (RetireExactInFlightToken(state, token)) {
            CFRelease((CFTypeRef)token);
        }
    }
}

static int RunProducer(NSString *deviceUid,
                       NSString *manifestSha256,
                       Sink *sink,
                       NSArray<NSData *> *frames,
                       NSArray<NSString *> *frameHashes,
                       uint64_t ticksPerSourceFrame) {
    // The cadence divides below, so an out-of-range value would be undefined behavior rather than
    // a misconfiguration. ParseOptions already rejects it; this refuses to trust a future caller.
    if (ticksPerSourceFrame < kMinimumTicksPerSourceFrame ||
        ticksPerSourceFrame > kMaximumTicksPerSourceFrame) {
        fprintf(stderr, "cmio-camera-writer: ticks per source frame must be in 1..60\n");
        return 1;
    }

    ProducerState *state = &gProducerState;
    atomic_init(&state->scheduled, 0);
    atomic_init(&state->enqueued, 0);
    atomic_init(&state->removed, 0);
    atomic_init(&state->backpressured, 0);
    atomic_init(&state->dropInFlight, 0);
    atomic_init(&state->dropQueueNonEmpty, 0);
    atomic_init(&state->dropCasLost, 0);
    atomic_init(&state->dropQueueFull, 0);
    atomic_init(&state->inFlightToken, 0);
    atomic_init(&state->callbackViolation, 0);

    CMSimpleQueueRef queue = NULL;
    OSStatus status = CMIOStreamCopyBufferQueue(sink->streamID, QueueAltered, state, &queue);
    if (status != noErr || queue == NULL) {
        PrintOSStatus(@"copy output buffer queue with callback", status);
        if (queue != NULL) CFRelease(queue);
        return 1;
    }
    int32_t queueCapacity = CMSimpleQueueGetCapacity(queue);
    int32_t initialQueueCount = CMSimpleQueueGetCount(queue);
    if (queueCapacity <= 0 || (uint32_t)queueCapacity < sink->queueSize ||
        queueCapacity > kMaximumCopiedQueueCapacity || initialQueueCount != 0) {
        fprintf(stderr,
                "cmio-camera-writer: copied output queue must be initially empty and within capacity %u..%d; got count=%d capacity=%d\n",
                (unsigned)sink->queueSize, kMaximumCopiedQueueCapacity, initialQueueCount, queueCapacity);
        CMSimpleQueueRef ignored = NULL;
        OSStatus unregisterStatus = CMIOStreamCopyBufferQueue(sink->streamID, NULL, NULL, &ignored);
        if (unregisterStatus != noErr) {
            PrintOSStatus(@"unregister callback after queue-capacity mismatch", unregisterStatus);
            // The extension may still own the callback/queue. Keep both retained until process exit.
            return 1;
        }
        if (ignored != NULL) CFRelease(ignored);
        CFRelease(queue);
        return 1;
    }

    BOOL started = NO;
    int exitCode = 0;
    status = CMIODeviceStartStream(sink->deviceID, sink->streamID);
    if (status != noErr) {
        PrintOSStatus(@"start output stream", status);
        exitCode = 1;
        goto cleanup;
    }
    started = YES;

    CMTime presentationBase = CMClockGetTime(CMClockGetHostTimeClock());
    if (!CMTIME_IS_NUMERIC(presentationBase)) {
        fprintf(stderr, "cmio-camera-writer: host time clock returned a non-numeric base timestamp\n");
        exitCode = 1;
        goto cleanup;
    }
    mach_timebase_info_data_t timebase;
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.numer == 0 || timebase.denom == 0) {
        fprintf(stderr, "cmio-camera-writer: failed to read monotonic clock timebase\n");
        exitCode = 1;
        goto cleanup;
    }
    const uint64_t tickNanoseconds = 1000000000ull / 60ull;
    const uint64_t tickAbsolute = MachTicksForNanoseconds(tickNanoseconds, timebase);
    uint64_t nextDeadline = mach_absolute_time();
    BOOL emittedReady = NO;

    while (!gStopRequested) {
        if (mach_absolute_time() < nextDeadline) (void)mach_wait_until(nextDeadline);
        if (gStopRequested) break;

        if (atomic_load_explicit(&state->callbackViolation, memory_order_acquire) != 0) {
            fprintf(stderr, "cmio-camera-writer: output callback returned an unowned or invalid token\n");
            exitCode = 1;
            break;
        }

        uint64_t scheduled = atomic_fetch_add_explicit(&state->scheduled, 1, memory_order_relaxed) + 1;
        if (atomic_load_explicit(&state->inFlightToken, memory_order_acquire) != 0) {
            atomic_fetch_add_explicit(&state->dropInFlight, 1, memory_order_relaxed);
            atomic_fetch_add_explicit(&state->backpressured, 1, memory_order_relaxed);
        } else if (CMSimpleQueueGetCount(queue) > 0) {
            atomic_fetch_add_explicit(&state->dropQueueNonEmpty, 1, memory_order_relaxed);
            atomic_fetch_add_explicit(&state->backpressured, 1, memory_order_relaxed);
        } else {
            NSUInteger frameIndex = (NSUInteger)(((scheduled - 1) / ticksPerSourceFrame) % frames.count);
            CMTime presentationTime = CMTimeAdd(presentationBase, CMTimeMake((int64_t)(scheduled - 1), 60));
            uint64_t sequenceNumber = atomic_load_explicit(&state->enqueued, memory_order_relaxed);
            CMSampleBufferRef sampleBuffer = CreateSampleBuffer(frames[frameIndex],
                                                                sink->formatDescription,
                                                                presentationTime,
                                                                sequenceNumber);
            if (sampleBuffer == NULL) {
                exitCode = 1;
                break;
            }
            uintptr_t expectedToken = 0;
            if (!atomic_compare_exchange_strong_explicit(&state->inFlightToken,
                                                         &expectedToken,
                                                         (uintptr_t)sampleBuffer,
                                                         memory_order_acq_rel,
                                                         memory_order_acquire)) {
                CFRelease(sampleBuffer);
                atomic_fetch_add_explicit(&state->dropCasLost, 1, memory_order_relaxed);
                atomic_fetch_add_explicit(&state->backpressured, 1, memory_order_relaxed);
            } else {
                status = CMSimpleQueueEnqueue(queue, sampleBuffer);
                FinalizeEnqueueOwnership(state, sampleBuffer, status);
                if (status != noErr) {
                    if (status == kCMSimpleQueueError_QueueIsFull) {
                        atomic_fetch_add_explicit(&state->dropQueueFull, 1, memory_order_relaxed);
                        atomic_fetch_add_explicit(&state->backpressured, 1, memory_order_relaxed);
                    } else {
                        PrintOSStatus(@"enqueue output sample", status);
                        exitCode = 1;
                        break;
                    }
                } else {
                    atomic_fetch_add_explicit(&state->enqueued, 1, memory_order_relaxed);
                    // DELIBERATE: the host stamp is taken AFTER CMSimpleQueueEnqueue returns, so it
                    // excludes the enqueue call itself and understates end-to-end latency by a few
                    // hundred nanoseconds. That is the correct direction — every latency this feeds
                    // is reported as isLowerBound in src/vcamthroughput.ts, and a stamp taken before
                    // the enqueue would inflate the number past what the evidence supports. Do not
                    // "fix" this by hoisting the mach_absolute_time() call above the enqueue.
                    RecordEnqueue(sequenceNumber,
                                  (uint64_t)frameIndex,
                                  NanosecondsForMachTicks(mach_absolute_time(), timebase),
                                  CMTimeGetSeconds(presentationTime) * 1000.0,
                                  frameHashes[frameIndex]);
                    if (gStopRequested) {
                        break;
                    }
                    if (!emittedReady) {
                        if (!EmitReady(deviceUid, manifestSha256, sink, queueCapacity)) {
                            fprintf(stderr, "cmio-camera-writer: failed to emit readiness JSONL\n");
                            exitCode = 1;
                            break;
                        }
                        emittedReady = YES;
                    }
                }
            }
        }

        if (scheduled % 60 == 0 && !EmitStats(@"periodic", state, NO)) {
            fprintf(stderr, "cmio-camera-writer: failed to emit periodic stats JSONL\n");
            exitCode = 1;
            break;
        }

        nextDeadline += tickAbsolute;
        uint64_t now = mach_absolute_time();
        if (nextDeadline <= now) nextDeadline = now + tickAbsolute;
    }

cleanup:
    exitCode = NormalizeExitCodeForStopRequest(exitCode, gStopRequested);
    if (started) {
        status = CMIODeviceStopStream(sink->deviceID, sink->streamID);
        if (status != noErr) {
            PrintOSStatus(@"stop output stream", status);
            exitCode = 1;
        }
    }
    CMSimpleQueueRef ignored = NULL;
    status = CMIOStreamCopyBufferQueue(sink->streamID, NULL, NULL, &ignored);
    if (status != noErr) {
        PrintOSStatus(@"unregister output queue callback", status);
        exitCode = 1;
    }
    // Neither successful stop nor callback unregistration is documented as a join with the
    // output consumer. Without an independent quiescence proof, do not become a second dequeuer
    // or release queue references that may still be used by provider work. This process exits
    // immediately, so intentionally retaining the queue and any remaining token is bounded.
    ReclaimStoppedQueue(queue, state, NO);
    if (!FlushEnqueueRecords()) {
        fprintf(stderr, "cmio-camera-writer: failed to emit enqueue record JSONL\n");
        exitCode = 1;
    }
    // This is a pre-exit snapshot, not a final callback count: stop/unregister did not prove a
    // consumer join, and process-lifetime retention intentionally leaves late work possible.
    if (!EmitStats(@"shutdown-snapshot", state, NO)) {
        fprintf(stderr, "cmio-camera-writer: failed to emit shutdown stats snapshot JSONL\n");
        exitCode = 1;
    }
    return exitCode;
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

        NSArray<NSData *> *frames = nil;
        NSArray<NSString *> *frameHashes = nil;
        if (!options.probeOnly) {
            frames = LoadAndValidateFrames(options.manifestPath, options.expectedManifestSha256, &frameHashes);
            if (frames == nil) return 65;
            if (gStopRequested) return NormalizeExitCodeForStopRequest(0, gStopRequested);
        }

        Sink sink;
        if (!DiscoverSink(options.deviceUid, &sink)) return 69;
        if (gStopRequested) {
            CFRelease(sink.formatDescription);
            return NormalizeExitCodeForStopRequest(0, gStopRequested);
        }
        if (options.probeOnly) {
            BOOL emitted = EmitProbe(options.deviceUid, &sink);
            CFRelease(sink.formatDescription);
            if (!emitted) {
                fprintf(stderr, "cmio-camera-writer: failed to emit probe JSONL\n");
                return 1;
            }
            return NormalizeExitCodeForStopRequest(0, gStopRequested);
        }

        int result = RunProducer(options.deviceUid,
                                 options.expectedManifestSha256,
                                 &sink,
                                 frames,
                                 frameHashes,
                                 options.ticksPerSourceFrame);
        CFRelease(sink.formatDescription);
        return result;
    }
}
