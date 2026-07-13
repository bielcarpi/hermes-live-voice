class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedFrameMs = Number(options?.processorOptions?.frameMs ?? 50);
    const frameMs = Number.isFinite(requestedFrameMs) ? Math.max(20, Math.min(100, requestedFrameMs)) : 50;
    this.buffer = new Int16Array(Math.max(1, Math.round(sampleRate * frameMs / 1000)));
    this.index = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.index] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      this.index += 1;
      if (this.index >= this.buffer.length) this.flush();
    }
    return true;
  }

  flush() {
    if (this.index === 0) return;
    const frame = this.buffer.slice(0, this.index).buffer;
    this.port.postMessage(frame, [frame]);
    this.index = 0;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
