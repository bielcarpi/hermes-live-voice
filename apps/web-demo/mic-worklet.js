class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(2048);
    this.index = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.index] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      this.index += 1;
      if (this.index >= this.buffer.length) {
        this.flush();
      }
    }
    return true;
  }

  flush() {
    if (this.index === 0) return;
    this.port.postMessage(this.buffer.slice(0, this.index).buffer);
    this.index = 0;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
