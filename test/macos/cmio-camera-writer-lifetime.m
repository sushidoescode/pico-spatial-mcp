#define main cmio_camera_writer_cli_main
#include "../../scripts/macos/cmio-camera-writer.m"
#undef main

static _Atomic BOOL gCallbackTokenDeallocated;

@interface CallbackLifetimeToken : NSObject
@end

@implementation CallbackLifetimeToken
- (void)dealloc {
    atomic_store_explicit(&gCallbackTokenDeallocated, YES, memory_order_release);
}
@end

static void InitializeCallbackState(ProducerState *state) {
    memset(state, 0, sizeof(*state));
    atomic_init(&state->inFlightToken, 0);
    atomic_init(&state->removed, 0);
    atomic_init(&state->callbackViolation, 0);
}

static void *CreateCallbackLifetimeToken(void) {
    atomic_store_explicit(&gCallbackTokenDeallocated, NO, memory_order_release);
    CallbackLifetimeToken *token = [[CallbackLifetimeToken alloc] init];
    return (__bridge_retained void *)token;
}

static int Fail(NSString *message) {
    fprintf(stderr, "cmio-camera-writer lifetime test: %s\n", message.UTF8String);
    return 1;
}

// The enqueue records and stats line are a cross-module wire format that src/vcamthroughput.ts
// parses by exact field name. Capturing stdout here joins the writer's emission to that contract,
// so a renamed field or a reordered argument fails the build instead of surfacing downstream as
// "malformed enqueue record". No CMIO API is involved.
static int gCaptureSavedStdout = -1;
static FILE *gCaptureFile = NULL;

static BOOL BeginStdoutCapture(void) {
    fflush(stdout);
    gCaptureFile = tmpfile();
    if (gCaptureFile == NULL) return NO;
    gCaptureSavedStdout = dup(STDOUT_FILENO);
    if (gCaptureSavedStdout < 0) {
        fclose(gCaptureFile);
        gCaptureFile = NULL;
        return NO;
    }
    if (dup2(fileno(gCaptureFile), STDOUT_FILENO) < 0) {
        close(gCaptureSavedStdout);
        gCaptureSavedStdout = -1;
        fclose(gCaptureFile);
        gCaptureFile = NULL;
        return NO;
    }
    return YES;
}

static NSString *EndStdoutCapture(void) {
    fflush(stdout);
    if (gCaptureSavedStdout >= 0) {
        (void)dup2(gCaptureSavedStdout, STDOUT_FILENO);
        close(gCaptureSavedStdout);
        gCaptureSavedStdout = -1;
    }
    if (gCaptureFile == NULL) return nil;
    NSString *text = nil;
    if (fseek(gCaptureFile, 0, SEEK_END) == 0) {
        long size = ftell(gCaptureFile);
        if (size >= 0 && fseek(gCaptureFile, 0, SEEK_SET) == 0) {
            NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)size];
            if (size == 0 || fread(data.mutableBytes, 1, (size_t)size, gCaptureFile) == (size_t)size) {
                text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            }
        }
    }
    fclose(gCaptureFile);
    gCaptureFile = NULL;
    return text;
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

        const char *stoppedArgv[] = {
            "cmio-camera-writer",
            "--device-uid", "00000000-0000-0000-0000-000000000001",
            "--width", "1280",
            "--height", "720",
            "--pixel-format", "BGRA",
            "--manifest", "/definitely-not-read-after-a-pending-stop.json",
            "--expected-manifest-sha256",
            "0000000000000000000000000000000000000000000000000000000000000000",
        };
        gStopRequested = SIGTERM;
        int stoppedResult = cmio_camera_writer_cli_main(
            (int)(sizeof(stoppedArgv) / sizeof(stoppedArgv[0])),
            stoppedArgv);
        gStopRequested = 0;
        if (stoppedResult != 128 + SIGTERM) {
            return Fail(@"CLI did not normalize a pending stop before manifest or CMIO access");
        }

        const NSUInteger frameBytes = kRequiredWidth * kRequiredHeight * 4;
        NSMutableData *frame = [NSMutableData dataWithLength:frameBytes];
        uint8_t *bytes = frame.mutableBytes;
        bytes[0] = 0x12;
        bytes[1] = 0x34;
        bytes[2] = 0x56;
        bytes[3] = 0x78;
        bytes[frameBytes - 1] = 0xab;

        CMVideoFormatDescriptionRef formatDescription = NULL;
        OSStatus status = CMVideoFormatDescriptionCreate(kCFAllocatorDefault,
                                                          kRequiredPixelFormat,
                                                          (int32_t)kRequiredWidth,
                                                          (int32_t)kRequiredHeight,
                                                          NULL,
                                                          &formatDescription);
        if (status != noErr || formatDescription == NULL) {
            return Fail(@"could not create the test format description");
        }

        CMSampleBufferRef sampleBuffer = CreateSampleBuffer(frame,
                                                            formatDescription,
                                                            CMTimeMake(0, 60),
                                                            0);
        if (sampleBuffer == NULL) {
            CFRelease(formatDescription);
            return Fail(@"CreateSampleBuffer returned NULL");
        }

        CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
        if (imageBuffer == NULL || CVPixelBufferGetIOSurface(imageBuffer) == NULL ||
            CVPixelBufferGetWidth(imageBuffer) != kRequiredWidth ||
            CVPixelBufferGetHeight(imageBuffer) != kRequiredHeight ||
            CVPixelBufferGetPixelFormatType(imageBuffer) != kRequiredPixelFormat) {
            CFRelease(sampleBuffer);
            CFRelease(formatDescription);
            return Fail(@"sample does not expose the expected IOSurface-backed image buffer");
        }

        CVReturn pixelStatus = CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
        if (pixelStatus != kCVReturnSuccess) {
            CFRelease(sampleBuffer);
            CFRelease(formatDescription);
            return Fail(@"could not lock the sample image buffer");
        }
        const uint8_t *copied = CVPixelBufferGetBaseAddress(imageBuffer);
        size_t stride = CVPixelBufferGetBytesPerRow(imageBuffer);
        BOOL contentMatches = copied != NULL && stride >= kRequiredWidth * 4 &&
                              copied[0] == 0x12 && copied[1] == 0x34 &&
                              copied[2] == 0x56 && copied[3] == 0x78 &&
                              copied[(kRequiredHeight - 1) * stride + kRequiredWidth * 4 - 1] == 0xab;
        pixelStatus = CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
        if (!contentMatches || pixelStatus != kCVReturnSuccess) {
            CFRelease(sampleBuffer);
            CFRelease(formatDescription);
            return Fail(@"sample image buffer did not retain the copied frame bytes");
        }

        // This release exercises the same sample -> image buffer -> IOSurface backing finalization
        // chain that faulted in the live CoreMediaIO worker.
        CFRelease(sampleBuffer);
        CFRelease(formatDescription);

        ProducerState callbackState;
        InitializeCallbackState(&callbackState);
        void *callbackToken = CreateCallbackLifetimeToken();
        atomic_store_explicit(&callbackState.inFlightToken,
                              (uintptr_t)callbackToken,
                              memory_order_release);
        FinalizeEnqueueOwnership(&callbackState, callbackToken, noErr);
        if (atomic_load_explicit(&gCallbackTokenDeallocated, memory_order_acquire) ||
            atomic_load_explicit(&callbackState.inFlightToken, memory_order_acquire) !=
                (uintptr_t)callbackToken) {
            CFRelease((CFTypeRef)callbackToken);
            return Fail(@"successful enqueue did not transfer its live token to CoreMediaIO");
        }
        QueueAltered(1, callbackToken, &callbackState);
        if (atomic_load_explicit(&gCallbackTokenDeallocated, memory_order_acquire)) {
            return Fail(@"queue callback reclaimed its token before returning");
        }
        if (atomic_load_explicit(&callbackState.inFlightToken, memory_order_acquire) != 0 ||
            atomic_load_explicit(&callbackState.removed, memory_order_relaxed) != 1 ||
            atomic_load_explicit(&callbackState.callbackViolation, memory_order_acquire) != 0) {
            CFRelease((CFTypeRef)callbackToken);
            return Fail(@"queue callback did not retire the exact in-flight token");
        }
        CFRelease((CFTypeRef)callbackToken);
        if (!atomic_load_explicit(&gCallbackTokenDeallocated, memory_order_acquire)) {
            return Fail(@"retired queue token could not be reclaimed outside the callback");
        }

        ProducerState failedEnqueueState;
        InitializeCallbackState(&failedEnqueueState);
        void *failedEnqueueToken = CreateCallbackLifetimeToken();
        atomic_store_explicit(&failedEnqueueState.inFlightToken,
                              (uintptr_t)failedEnqueueToken,
                              memory_order_release);
        FinalizeEnqueueOwnership(&failedEnqueueState,
                                 failedEnqueueToken,
                                 kCMSimpleQueueError_QueueIsFull);
        if (!atomic_load_explicit(&gCallbackTokenDeallocated, memory_order_acquire) ||
            atomic_load_explicit(&failedEnqueueState.inFlightToken, memory_order_acquire) != 0 ||
            atomic_load_explicit(&failedEnqueueState.callbackViolation, memory_order_acquire) != 0) {
            return Fail(@"failed enqueue did not reclaim exactly its caller-owned token");
        }

        ProducerState stoppedQueueState;
        InitializeCallbackState(&stoppedQueueState);
        CMSimpleQueueRef stoppedQueue = NULL;
        status = CMSimpleQueueCreate(kCFAllocatorDefault, 1, &stoppedQueue);
        if (status != noErr || stoppedQueue == NULL) {
            return Fail(@"could not create the stopped-queue ownership fixture");
        }
        void *stoppedQueueToken = CreateCallbackLifetimeToken();
        atomic_store_explicit(&stoppedQueueState.inFlightToken,
                              (uintptr_t)stoppedQueueToken,
                              memory_order_release);
        status = CMSimpleQueueEnqueue(stoppedQueue, stoppedQueueToken);
        if (status != noErr) {
            CFRelease((CFTypeRef)stoppedQueueToken);
            CFRelease(stoppedQueue);
            return Fail(@"could not enqueue the stopped-queue ownership fixture");
        }
        FinalizeEnqueueOwnership(&stoppedQueueState, stoppedQueueToken, noErr);
        ReclaimStoppedQueue(stoppedQueue, &stoppedQueueState, NO);
        if (atomic_load_explicit(&gCallbackTokenDeallocated, memory_order_acquire) ||
            CMSimpleQueueGetCount(stoppedQueue) != 1 ||
            atomic_load_explicit(&stoppedQueueState.inFlightToken, memory_order_acquire) !=
                (uintptr_t)stoppedQueueToken) {
            CFRelease(stoppedQueue);
            return Fail(@"stopped queue reclaimed a token without consumer-quiescence proof");
        }
        ReclaimStoppedQueue(stoppedQueue, &stoppedQueueState, YES);
        if (!atomic_load_explicit(&gCallbackTokenDeallocated, memory_order_acquire) ||
            CMSimpleQueueGetCount(stoppedQueue) != 0 ||
            atomic_load_explicit(&stoppedQueueState.inFlightToken, memory_order_acquire) != 0 ||
            atomic_load_explicit(&stoppedQueueState.callbackViolation, memory_order_acquire) != 0) {
            CFRelease(stoppedQueue);
            return Fail(@"proven-quiescent stopped queue did not reclaim its exact token");
        }
        CFRelease(stoppedQueue);

        // Lowercase hex is a hard requirement of the analyzer's /^[0-9a-f]{64}$/ validator, and the
        // record path carries whatever SHA256Hex produced. Pin the well-known digest of empty input
        // so a "%02X" regression fails here rather than as an unexplained downstream confound.
        NSString *emptyDigest = SHA256Hex([NSData data]);
        if (![emptyDigest isEqualToString:@"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"] ||
            !IsSHA256(emptyDigest)) {
            return Fail(@"SHA256Hex no longer renders the canonical lowercase digest");
        }

        NSString *firstHash = [@"" stringByPaddingToLength:CC_SHA256_DIGEST_LENGTH * 2
                                                withString:@"ab"
                                           startingAtIndex:0];
        NSString *secondHash = [@"" stringByPaddingToLength:CC_SHA256_DIGEST_LENGTH * 2
                                                 withString:@"cd"
                                            startingAtIndex:0];
        if (!IsSHA256(firstHash) || !IsSHA256(secondHash)) {
            return Fail(@"record fixtures are not valid lowercase SHA-256 strings");
        }

        RecordEnqueue(11, 1, 1000000007ull, 1234.5678, firstHash);
        RecordEnqueue(22, 2, 1016666673ull, 1251.2345, secondHash);
        if (gEnqueueRecordCount != 2 || gEnqueueRecordsTruncated) {
            return Fail(@"two enqueue records did not land unflagged");
        }

        ProducerState statsState;
        InitializeCallbackState(&statsState);
        atomic_init(&statsState.scheduled, 40);
        atomic_init(&statsState.enqueued, 2);
        atomic_init(&statsState.removed, 2);
        // Deliberately distinct so transposing two arguments in the fprintf list cannot pass.
        atomic_init(&statsState.dropInFlight, 3);
        atomic_init(&statsState.dropQueueNonEmpty, 5);
        atomic_init(&statsState.dropCasLost, 7);
        atomic_init(&statsState.dropQueueFull, 11);
        atomic_init(&statsState.backpressured, 3 + 5 + 7 + 11);

        if (!BeginStdoutCapture()) return Fail(@"could not capture stdout for the wire-format check");
        BOOL emitted = FlushEnqueueRecords() && EmitStats(@"shutdown-snapshot", &statsState, NO);
        NSString *captured = EndStdoutCapture();
        if (!emitted) return Fail(@"record flush or stats emission reported a write failure");
        if (captured == nil) return Fail(@"captured stdout was not readable UTF-8");

        NSArray<NSString *> *lines = [captured componentsSeparatedByString:@"\n"];
        // Exactly three newline-terminated lines: two enqueue records plus one stats record, which
        // split into four components with an empty tail. `!=` rather than `<` so a spurious FOURTH
        // emitted line — an extra record, a stray debug print on the same stream the analyzer
        // parses — fails here instead of being silently tolerated.
        if (lines.count != 4 || ((NSString *)lines.lastObject).length != 0) {
            return Fail(@"emitted JSONL must be exactly three newline-terminated lines");
        }
        NSString *expectedFirst = [NSString stringWithFormat:
            @"{\"event\":\"enqueue\",\"sequence\":11,\"frameIndex\":1,\"sha256\":\"%@\","
             "\"hostTimeNs\":1000000007,\"presentationTimeMs\":1234.5678}", firstHash];
        NSString *expectedSecond = [NSString stringWithFormat:
            @"{\"event\":\"enqueue\",\"sequence\":22,\"frameIndex\":2,\"sha256\":\"%@\","
             "\"hostTimeNs\":1016666673,\"presentationTimeMs\":1251.2345}", secondHash];
        if (![lines[0] isEqualToString:expectedFirst] || ![lines[1] isEqualToString:expectedSecond]) {
            fprintf(stderr, "cmio-camera-writer lifetime test: emitted enqueue line was %s\n",
                    lines[0].UTF8String);
            return Fail(@"enqueue records do not match the field-for-field analyzer contract");
        }

        NSArray<NSString *> *requiredStatsFields = @[
            @"\"event\":\"stats\"", @"\"phase\":\"shutdown-snapshot\"",
            @"\"backpressured\":26", @"\"dropInFlight\":3", @"\"dropQueueNonEmpty\":5",
            @"\"dropCasLost\":7", @"\"dropQueueFull\":11", @"\"recordsTruncated\":false",
        ];
        for (NSString *field in requiredStatsFields) {
            if ([lines[2] rangeOfString:field].location == NSNotFound) {
                fprintf(stderr, "cmio-camera-writer lifetime test: stats line %s lacks %s\n",
                        lines[2].UTF8String, field.UTF8String);
                return Fail(@"stats line does not carry the named drop causes the analyzer reads");
            }
        }

        // Bounded and never wrapped: overflow must stop recording and keep the OLDEST records,
        // because the analyzer anchors on the latest enqueue at or before each observation.
        for (NSUInteger extra = 0; extra <= (NSUInteger)kMaximumEnqueueRecords; extra += 1) {
            RecordEnqueue(1000 + extra, 0, 2000000000ull + extra, 9.0, secondHash);
        }
        if (gEnqueueRecordCount != (NSUInteger)kMaximumEnqueueRecords || !gEnqueueRecordsTruncated) {
            return Fail(@"enqueue record overflow did not clamp and flag truncation");
        }
        if (gEnqueueRecords[0].sequence != 11 || gEnqueueRecords[0].frameIndex != 1 ||
            gEnqueueRecords[0].hostTimeNs != 1000000007ull ||
            strcmp(gEnqueueRecords[0].sha256, firstHash.UTF8String) != 0) {
            return Fail(@"enqueue record buffer wrapped instead of stopping at capacity");
        }

        if (!BeginStdoutCapture()) return Fail(@"could not capture stdout for the truncation check");
        BOOL truncatedEmitted = EmitStats(@"shutdown-snapshot", &statsState, NO);
        NSString *truncatedStats = EndStdoutCapture();
        if (!truncatedEmitted || truncatedStats == nil) {
            return Fail(@"could not emit stats after the record buffer filled");
        }
        if ([truncatedStats rangeOfString:@"\"recordsTruncated\":true"].location == NSNotFound) {
            return Fail(@"a truncated record buffer did not report recordsTruncated:true");
        }
    }

    puts("cmio-camera-writer lifetime test: sample/image, queue ownership, and enqueue-record wire format passed");
    return 0;
}
