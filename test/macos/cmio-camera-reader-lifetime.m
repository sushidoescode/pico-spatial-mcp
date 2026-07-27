#define main cmio_camera_reader_cli_main
#include "../../scripts/macos/cmio-camera-reader.m"
#undef main

#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

static int Fail(NSString *message) {
    fprintf(stderr, "cmio-camera-reader lifetime test: %s\n", message.UTF8String);
    return 1;
}

// ParseOptions writes a diagnostic to stderr for every rejection. The rejection cases below are
// EXPECTED, so their diagnostics are muted to keep a passing gate quiet; real failures print after
// stderr is restored.
static int gSavedStandardError = -1;

static BOOL MuteStandardError(void) {
    fflush(stderr);
    int devNull = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (devNull < 0) return NO;
    gSavedStandardError = dup(STDERR_FILENO);
    if (gSavedStandardError < 0) {
        close(devNull);
        return NO;
    }
    BOOL redirected = dup2(devNull, STDERR_FILENO) >= 0;
    close(devNull);
    return redirected;
}

static void RestoreStandardError(void) {
    fflush(stderr);
    if (gSavedStandardError < 0) return;
    (void)dup2(gSavedStandardError, STDERR_FILENO);
    close(gSavedStandardError);
    gSavedStandardError = -1;
}

// The frame and readback records are a cross-module wire format that src/vcamthroughput.ts parses
// by exact field name. Parsing them back as JSON here joins the reader's emission to that contract,
// so a renamed field, an unescaped value, or a changed null-handling rule fails the build instead
// of surfacing downstream as a generic "malformed frame record". No AVFoundation session is opened.
static NSDictionary *ParseRecord(NSString *record) {
    NSData *data = [record dataUsingEncoding:NSUTF8StringEncoding];
    if (data == nil) return nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    return [parsed isKindOfClass:[NSDictionary class]] ? parsed : nil;
}

// Typed field readers: NSNumber and NSString both respond to longLongValue/doubleValue, so binding
// the type here keeps the assertions unambiguous and makes a wrong-typed field fail loudly.
static long long IntegerField(NSDictionary *record, NSString *key) {
    id value = record[key];
    return [value isKindOfClass:[NSNumber class]] ? [(NSNumber *)value longLongValue] : LLONG_MIN;
}

static double DoubleField(NSDictionary *record, NSString *key) {
    id value = record[key];
    return [value isKindOfClass:[NSNumber class]] ? [(NSNumber *)value doubleValue] : NAN;
}

// Phrased so a MISSING field fails. `fabs(NAN - expected) > tolerance` is false under IEEE, which
// would let a deleted field pass silently; requiring isfinite and an in-tolerance match cannot.
static BOOL DoubleFieldEquals(NSDictionary *record, NSString *key, double expected) {
    double value = DoubleField(record, key);
    return isfinite(value) && fabs(value - expected) <= 0.001;
}

// The delegate ignores its output and connection arguments, and this seam deliberately has no
// capture session to own real ones. Returned from functions so the AVFoundation nonnull annotations
// — which describe AVFoundation's own call site, not this one — are not tripped by a literal nil.
static AVCaptureOutput *UnusedCaptureOutput(void) {
    return nil;
}

static AVCaptureConnection *UnusedCaptureConnection(void) {
    return nil;
}

static NSString *gScratchDirectory = nil;

static int FailAndClean(NSString *message) {
    if (gScratchDirectory != nil) {
        [[NSFileManager defaultManager] removeItemAtPath:gScratchDirectory error:NULL];
    }
    return Fail(message);
}

static BOOL IsLowercaseSHA256(id value) {
    if (![value isKindOfClass:[NSString class]]) return NO;
    NSString *text = value;
    if (text.length != CC_SHA256_DIGEST_LENGTH * 2) return NO;
    NSCharacterSet *notLowercaseHex =
        [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
    return [text rangeOfCharacterFromSet:notLowercaseHex].location == NSNotFound;
}

// ParseOptions is a pure argv function that touches no CoreMediaIO and no AVFoundation, so the
// mode-dependent frame bound can be proven directly, in both flag orders.
static BOOL ParseArgv(const char *argv[], int argc, NSUInteger *framesOut, BOOL *noPreviewOut) {
    Options options = {0};
    BOOL accepted = ParseOptions(argc, argv, &options);
    if (framesOut != NULL) *framesOut = options.frames;
    if (noPreviewOut != NULL) *noPreviewOut = options.noPreview;
    return accepted;
}

// A synthetic BGRA sample buffer, built from CoreVideo/CoreMedia only. It carries no CoreMediaIO
// object and never touches a capture device, so the real delegate can be driven with it directly.
// The row padding is poisoned so a bytesPerRow-wide hash cannot match the tightly packed digest.
static CMSampleBufferRef CreateTestSampleBuffer(size_t width,
                                                size_t height,
                                                uint8_t seed,
                                                CMTime presentationTime,
                                                NSData **packedBytesOut) {
    *packedBytesOut = nil;
    CVPixelBufferRef pixelBuffer = NULL;
    NSDictionary *attributes = @{ (__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{} };
    if (CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                            (__bridge CFDictionaryRef)attributes, &pixelBuffer) != kCVReturnSuccess ||
        pixelBuffer == NULL) {
        return NULL;
    }
    if (CVPixelBufferLockBaseAddress(pixelBuffer, 0) != kCVReturnSuccess) {
        CVPixelBufferRelease(pixelBuffer);
        return NULL;
    }
    uint8_t *base = CVPixelBufferGetBaseAddress(pixelBuffer);
    size_t stride = CVPixelBufferGetBytesPerRow(pixelBuffer);
    NSMutableData *packed = [NSMutableData dataWithLength:width * height * 4];
    uint8_t *packedBytes = packed.mutableBytes;
    if (base == NULL || stride < width * 4 || packedBytes == NULL) {
        CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
        CVPixelBufferRelease(pixelBuffer);
        return NULL;
    }
    for (size_t row = 0; row < height; row += 1) {
        for (size_t column = 0; column < width * 4; column += 1) {
            uint8_t value = (uint8_t)((row * 31u + column * 7u + seed) & 0xffu);
            base[row * stride + column] = value;
            packedBytes[row * width * 4 + column] = value;
        }
        for (size_t column = width * 4; column < stride; column += 1) base[row * stride + column] = 0xa5;
    }
    CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);

    CMVideoFormatDescriptionRef format = NULL;
    if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixelBuffer, &format) != noErr ||
        format == NULL) {
        CVPixelBufferRelease(pixelBuffer);
        return NULL;
    }
    CMSampleTimingInfo timing = {
        .duration = kCMTimeInvalid,
        .presentationTimeStamp = presentationTime,
        .decodeTimeStamp = kCMTimeInvalid,
    };
    CMSampleBufferRef sample = NULL;
    OSStatus status = CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault, pixelBuffer, true, NULL, NULL,
                                                         format, &timing, &sample);
    CFRelease(format);
    CVPixelBufferRelease(pixelBuffer);
    if (status != noErr || sample == NULL) {
        if (sample != NULL) CFRelease(sample);
        return NULL;
    }
    *packedBytesOut = packed;
    return sample;
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

        // ---- host arrival time is NANOSECONDS, not raw mach ticks ------------------------------
        // The sibling producer stamps every enqueue with this same monotonic clock scaled by this
        // same timebase, and the throughput analyzer SUBTRACTS one stamp from the other. Raw ticks
        // would still parse, still validate, and still yield a plausible-looking latency that
        // nothing downstream could flag — so the conversion is asserted here, not trusted.
        mach_timebase_info_data_t hostTimebase;
        if (mach_timebase_info(&hostTimebase) != KERN_SUCCESS ||
            hostTimebase.numer == 0 || hostTimebase.denom == 0) {
            return Fail(@"could not read the host mach timebase");
        }
        mach_timebase_info_data_t appleSiliconTimebase = { .numer = 125, .denom = 3 };
        mach_timebase_info_data_t identityTimebase = { .numer = 1, .denom = 1 };
        mach_timebase_info_data_t unreadableTimebase = { .numer = 0, .denom = 0 };
        if (NanosecondsForMachTicks(24000000ull, appleSiliconTimebase) != 1000000000ull ||
            NanosecondsForMachTicks(3, appleSiliconTimebase) != 125 ||
            NanosecondsForMachTicks(123456789ull, identityTimebase) != 123456789ull ||
            NanosecondsForMachTicks(1000, unreadableTimebase) != 0) {
            return Fail(@"NanosecondsForMachTicks does not scale mach ticks by the supplied timebase");
        }
        // elapsedMs is a millisecond field computed from a nanosecond span; a missing divisor on
        // the live readback path would look entirely plausible in the emitted record.
        if (MillisecondsForNanoseconds(1500000ull) != 1.5 ||
            MillisecondsForNanoseconds(0) != 0.0 ||
            MillisecondsForNanoseconds(1000000000ull) != 1000.0) {
            return Fail(@"MillisecondsForNanoseconds does not convert nanoseconds to milliseconds");
        }
        const uint64_t probeTicks = 1000000000ull;
        if (MachAbsoluteToNanoseconds(probeTicks) != NanosecondsForMachTicks(probeTicks, hostTimebase)) {
            return Fail(@"MachAbsoluteToNanoseconds does not apply the host timebase");
        }
        // Cross-checked against the documented nanosecond view of the very same monotonic clock, so
        // the assertion still discriminates on a host whose timebase happens to be 1/1.
        uint64_t machNanoseconds = MachAbsoluteToNanoseconds(mach_absolute_time());
        uint64_t uptimeNanoseconds = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
        uint64_t clockSkew = machNanoseconds > uptimeNanoseconds
            ? machNanoseconds - uptimeNanoseconds
            : uptimeNanoseconds - machNanoseconds;
        if (clockSkew > 50ull * NSEC_PER_MSEC) {
            fprintf(stderr, "cmio-camera-reader lifetime test: host stamp %llu vs CLOCK_UPTIME_RAW %llu\n",
                    (unsigned long long)machNanoseconds, (unsigned long long)uptimeNanoseconds);
            return Fail(@"the host stamp is not on the same nanosecond scale as CLOCK_UPTIME_RAW");
        }

        // ---- the readback frame cap follows the MODE, not the flag order -----------------------
        if (MaximumReadbackFramesForMode(NO) != 240 || MaximumReadbackFramesForMode(YES) != 3600) {
            return Fail(@"the readback frame cap is not 240 with previews and 3600 without them");
        }
        const char *previewOverCapArgv[] = {
            "cmio-camera-reader", "--avfoundation-readback",
            "--device-uid", "00000000-0000-0000-0000-000000000001",
            "--output-dir", "/tmp", "--timeout-ms", "1000", "--frames", "3600",
        };
        const char *noPreviewLastArgv[] = {
            "cmio-camera-reader", "--avfoundation-readback",
            "--device-uid", "00000000-0000-0000-0000-000000000001",
            "--output-dir", "/tmp", "--timeout-ms", "1000", "--frames", "3600", "--no-preview",
        };
        const char *noPreviewFirstArgv[] = {
            "cmio-camera-reader", "--avfoundation-readback", "--no-preview",
            "--device-uid", "00000000-0000-0000-0000-000000000001",
            "--output-dir", "/tmp", "--timeout-ms", "1000", "--frames", "3600",
        };
        const char *noPreviewOverCapArgv[] = {
            "cmio-camera-reader", "--avfoundation-readback", "--no-preview",
            "--device-uid", "00000000-0000-0000-0000-000000000001",
            "--output-dir", "/tmp", "--timeout-ms", "1000", "--frames", "3601",
        };
        const char *previewAtCapArgv[] = {
            "cmio-camera-reader", "--avfoundation-readback",
            "--device-uid", "00000000-0000-0000-0000-000000000001",
            "--output-dir", "/tmp", "--timeout-ms", "1000", "--frames", "240",
        };
        NSUInteger framesWithFlagLast = 0;
        NSUInteger framesWithFlagFirst = 0;
        BOOL noPreviewParsed = NO;
        if (!MuteStandardError()) return Fail(@"could not mute the expected rejection diagnostics");
        BOOL previewOverCapRejected = !ParseArgv(previewOverCapArgv, 10, NULL, NULL);
        BOOL noPreviewLastAccepted = ParseArgv(noPreviewLastArgv, 11, &framesWithFlagLast, &noPreviewParsed);
        BOOL noPreviewFirstAccepted = ParseArgv(noPreviewFirstArgv, 11, &framesWithFlagFirst, NULL);
        BOOL noPreviewOverCapRejected = !ParseArgv(noPreviewOverCapArgv, 11, NULL, NULL);
        BOOL previewAtCapAccepted = ParseArgv(previewAtCapArgv, 10, NULL, NULL);
        RestoreStandardError();
        if (!previewOverCapRejected || !previewAtCapAccepted) {
            return Fail(@"the preview-mode frame bound is not 1..240");
        }
        if (!noPreviewLastAccepted || framesWithFlagLast != 3600 || !noPreviewParsed ||
            !noPreviewOverCapRejected) {
            return Fail(@"the preview-free frame bound is not 1..3600");
        }
        if (!noPreviewFirstAccepted || framesWithFlagFirst != 3600) {
            return Fail(@"the frame bound follows argv order instead of the selected mode");
        }

        // ---- the per-frame record: the real delegate, a synthetic sample, no capture device ----
        // Lowercase hex is a hard requirement of the analyzer's /^[0-9a-f]{64}$/ validator, and the
        // record carries whatever HexEncode produced. Pin the canonical empty digest so a "%02X"
        // regression fails here rather than as an unexplained downstream "malformed frame record".
        NSString *emptyDigest = SHA256HexOfData([NSData data]);
        if (![emptyDigest isEqualToString:@"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"] ||
            !IsLowercaseSHA256(emptyDigest)) {
            return Fail(@"SHA256HexOfData no longer renders the canonical lowercase digest");
        }

        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSString *scratchDirectory = [NSTemporaryDirectory() stringByAppendingPathComponent:
                                      [NSString stringWithFormat:@"pico-vcam-reader-seam-%d", (int)getpid()]];
        [fileManager removeItemAtPath:scratchDirectory error:NULL];
        if (![fileManager createDirectoryAtPath:scratchDirectory
                    withIntermediateDirectories:YES
                                     attributes:nil
                                          error:NULL]) {
            return Fail(@"could not create the preview scratch directory");
        }
        gScratchDirectory = scratchDirectory;

        NSData *packedBytes = nil;
        CMSampleBufferRef sample = CreateTestSampleBuffer(8, 4, 0x11, CMTimeMake(1250, 1000), &packedBytes);
        if (sample == NULL || packedBytes == nil) {
            return FailAndClean(@"could not build the synthetic BGRA sample buffer");
        }
        FrameCollector *plainCollector = [[FrameCollector alloc] initWithTarget:4
                                                                      outputDir:scratchDirectory
                                                                  writePreviews:NO];
        uint64_t beforeDelegate = MachAbsoluteToNanoseconds(mach_absolute_time());
        [plainCollector captureOutput:UnusedCaptureOutput()
                didOutputSampleBuffer:sample
                       fromConnection:UnusedCaptureConnection()];
        uint64_t afterDelegate = MachAbsoluteToNanoseconds(mach_absolute_time());
        CFRelease(sample);

        if (plainCollector.records.count != 1) {
            return FailAndClean(@"the delegate did not record exactly one frame for one sample");
        }
        NSDictionary *frame = ParseRecord(plainCollector.records[0]);
        if (frame == nil) return FailAndClean(@"the per-frame record is not parseable JSON");
        if (![frame[@"event"] isEqual:@"frame"] ||
            IntegerField(frame, @"index") != 0 ||
            IntegerField(frame, @"width") != 8 ||
            IntegerField(frame, @"height") != 4 ||
            ![frame[@"pixelFormat"] isEqual:@"BGRA"]) {
            fprintf(stderr, "cmio-camera-reader lifetime test: frame record was %s\n",
                    plainCollector.records[0].UTF8String);
            return FailAndClean(@"the per-frame record lost an identity field the analyzer parses");
        }
        // presentationTimeMs is the SOURCE-side stamp and stays exactly what it was; hostTimeNs is
        // the newly added arrival time, not a replacement for it.
        if (!DoubleFieldEquals(frame, @"presentationTimeMs", 1250.0)) {
            return FailAndClean(@"presentationTimeMs is no longer the source timestamp in milliseconds");
        }
        if (![frame[@"rawSha256"] isEqual:SHA256HexOfData(packedBytes)] ||
            !IsLowercaseSHA256(frame[@"rawSha256"])) {
            return FailAndClean(@"rawSha256 is not the lowercase digest of the tightly packed BGRA rows");
        }
        if (frame[@"previewSha256"] != [NSNull null] || frame[@"previewPath"] != [NSNull null]) {
            return FailAndClean(@"a preview-free frame must emit previewSha256/previewPath as JSON null");
        }
        id hostTimeValue = frame[@"hostTimeNs"];
        if (![hostTimeValue isKindOfClass:[NSNumber class]]) {
            return FailAndClean(@"the per-frame record must carry a numeric hostTimeNs");
        }
        uint64_t recordedHostTimeNs = [(NSNumber *)hostTimeValue unsignedLongLongValue];
        if (recordedHostTimeNs < beforeDelegate || recordedHostTimeNs > afterDelegate) {
            fprintf(stderr, "cmio-camera-reader lifetime test: hostTimeNs %llu outside [%llu, %llu]\n",
                    (unsigned long long)recordedHostTimeNs,
                    (unsigned long long)beforeDelegate,
                    (unsigned long long)afterDelegate);
            return FailAndClean(@"hostTimeNs is not a host-timebase nanosecond stamp taken in the delegate");
        }

        // ---- previews on: the same record shape, with the two fields populated -----------------
        NSData *previewPackedBytes = nil;
        CMSampleBufferRef previewSample = CreateTestSampleBuffer(8, 4, 0x77, CMTimeMake(2500, 1000),
                                                                 &previewPackedBytes);
        if (previewSample == NULL || previewPackedBytes == nil) {
            return FailAndClean(@"could not build the preview sample buffer");
        }
        FrameCollector *previewCollector = [[FrameCollector alloc] initWithTarget:4
                                                                        outputDir:scratchDirectory
                                                                    writePreviews:YES];
        [previewCollector captureOutput:UnusedCaptureOutput()
                  didOutputSampleBuffer:previewSample
                         fromConnection:UnusedCaptureConnection()];
        CFRelease(previewSample);
        if (previewCollector.records.count != 1) {
            return FailAndClean(@"the preview-mode delegate did not record its frame");
        }
        NSDictionary *previewFrame = ParseRecord(previewCollector.records[0]);
        if (previewFrame == nil) return FailAndClean(@"the preview-mode record is not parseable JSON");
        if (![previewFrame[@"rawSha256"] isEqual:SHA256HexOfData(previewPackedBytes)]) {
            return FailAndClean(@"the preview path altered the raw frame digest");
        }
        if (!IsLowercaseSHA256(previewFrame[@"previewSha256"])) {
            return FailAndClean(@"previewSha256 must be a lowercase SHA-256 when previews are written");
        }
        id previewPathValue = previewFrame[@"previewPath"];
        if (![previewPathValue isKindOfClass:[NSString class]]) {
            return FailAndClean(@"previewPath must be a string when previews are written");
        }
        NSString *previewPath = previewPathValue;
        if (![previewPath hasSuffix:@".png"] || ![fileManager fileExistsAtPath:previewPath]) {
            return FailAndClean(@"previewPath must name the PNG the delegate actually wrote");
        }

        // ---- drop accounting -------------------------------------------------------------------
        // A dropped sample must be counted and must NOT be recorded as a captured frame.
        NSData *droppedPackedBytes = nil;
        CMSampleBufferRef droppedSample = CreateTestSampleBuffer(8, 4, 0x5a, CMTimeMake(3750, 1000),
                                                                 &droppedPackedBytes);
        if (droppedSample == NULL) return FailAndClean(@"could not build the dropped sample buffer");
        [plainCollector captureOutput:UnusedCaptureOutput()
                  didDropSampleBuffer:droppedSample
                       fromConnection:UnusedCaptureConnection()];
        [plainCollector captureOutput:UnusedCaptureOutput()
                  didDropSampleBuffer:droppedSample
                       fromConnection:UnusedCaptureConnection()];
        CFRelease(droppedSample);
        if (plainCollector.droppedFrames != 2 || plainCollector.records.count != 1) {
            return FailAndClean(@"didDropSampleBuffer must count the drop without recording a frame");
        }

        // ---- the readback summary line ---------------------------------------------------------
        // Deliberately distinct values, so transposing two arguments in the format list cannot pass.
        NSString *summaryText = ReadbackSummaryRecord(@"UID-1", scratchDirectory, 5, 7, 3, 11, 1234.5, NO, YES);
        NSDictionary *summary = ParseRecord(summaryText);
        if (summary == nil) return FailAndClean(@"the readback summary is not parseable JSON");
        if (![summary[@"event"] isEqual:@"readback"] ||
            ![summary[@"mode"] isEqual:@"avfoundation-readback"] ||
            ![summary[@"authStatus"] isEqual:@"authorized"] ||
            ![summary[@"deviceUid"] isEqual:@"UID-1"] ||
            IntegerField(summary, @"requestedFrames") != 5 ||
            IntegerField(summary, @"framesCaptured") != 7 ||
            IntegerField(summary, @"distinctRawHashes") != 3 ||
            IntegerField(summary, @"dropped") != 11 ||
            !DoubleFieldEquals(summary, @"elapsedMs", 1234.5) ||
            ![summary[@"changingFrames"] isEqual:@YES] ||
            ![summary[@"timedOut"] isEqual:@NO] ||
            ![summary[@"previews"] isEqual:@NO] ||
            ![summary[@"ok"] isEqual:@YES]) {
            fprintf(stderr, "cmio-camera-reader lifetime test: summary was %s\n", summaryText.UTF8String);
            return FailAndClean(@"the readback summary does not carry the fields the analyzer reads");
        }
        // A short, static capture is never ok, and the summary states which mode produced it.
        NSDictionary *staticSummary =
            ParseRecord(ReadbackSummaryRecord(@"UID-1", scratchDirectory, 5, 2, 1, 0, 10.0, YES, NO));
        if (staticSummary == nil ||
            ![staticSummary[@"ok"] isEqual:@NO] ||
            ![staticSummary[@"changingFrames"] isEqual:@NO] ||
            ![staticSummary[@"timedOut"] isEqual:@YES] ||
            ![staticSummary[@"previews"] isEqual:@YES]) {
            return FailAndClean(@"a short static readback must report ok:false alongside its mode");
        }

        [fileManager removeItemAtPath:scratchDirectory error:NULL];
        gScratchDirectory = nil;
    }

    puts("cmio-camera-reader lifetime test: signal/stop, host-time scale, frame cap, and record wire format passed");
    return 0;
}
