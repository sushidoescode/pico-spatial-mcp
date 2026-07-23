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
    }

    puts("cmio-camera-writer lifetime test: sample/image and queue ownership state passed");
    return 0;
}
