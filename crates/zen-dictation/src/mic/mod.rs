//! Microphone capture with cpal + resampling to 16 kHz f32 mono.
//!
//! whisper.cpp's `whisper_full` requires 16 kHz f32 mono PCM. Most
//! macOS input devices deliver 44.1 / 48 kHz at the native channel
//! count. We:
//!
//! 1. Open the default input stream at its native sample rate / channel
//!    count.
//! 2. Append every callback's samples into a shared `Vec<f32>` (after
//!    downmixing to mono if the device is multi-channel) under a
//!    parking_lot mutex.
//! 3. On stop, swap the buffer out and resample to 16 kHz with
//!    `rubato::SincFixedIn`.
//!
//! cpal streams hold a system thread for the duration of the
//! recording, so we keep the [`MicCapture`] owned by the dictation
//! manager for the full press → release cycle.

use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;

use crate::error::DictationError;

const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Active microphone capture. Hold the value to keep the cpal stream
/// alive; call [`MicCapture::stop`] to retrieve the recorded samples
/// (16 kHz f32 mono).
///
/// We assert `Send` on the cpal stream wrapper. cpal's CoreAudio
/// backend `Stream` is technically `!Send` because it owns a
/// `AudioUnit` pointer, but in practice the stream is operated in a
/// strict start → stop sequence from a single owner — we never
/// concurrently call methods from multiple threads. The dictation
/// manager moves the capture between hotkey-callback and
/// transcription-task threads, but only one at a time.
pub struct MicCapture {
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    source_sample_rate: u32,
    source_channels: u16,
}

// SAFETY: see MicCapture doc comment — we serialise access by hand.
unsafe impl Send for MicCapture {}

impl MicCapture {
    /// Begin recording from the OS's default input device. The cpal
    /// stream is started immediately; samples accumulate in an internal
    /// buffer until [`stop`] is called.
    pub fn start() -> Result<Self, DictationError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| DictationError::Audio("no default input device".into()))?;

        let config = device
            .default_input_config()
            .map_err(|e| DictationError::Audio(format!("default_input_config: {e}")))?;

        let source_sample_rate = config.sample_rate().0;
        let source_channels = config.channels();
        tracing::info!(
            sample_rate = source_sample_rate,
            channels = source_channels,
            sample_format = ?config.sample_format(),
            "starting mic capture"
        );

        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(
            (source_sample_rate as usize) * 60, // pre-size for ~1 minute
        )));

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config.into(), samples.clone())?,
            cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config.into(), samples.clone())?,
            cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config.into(), samples.clone())?,
            other => {
                return Err(DictationError::Audio(format!(
                    "unsupported sample format: {other:?}"
                )))
            }
        };

        stream
            .play()
            .map_err(|e| DictationError::Audio(format!("stream.play: {e}")))?;

        Ok(MicCapture {
            stream,
            samples,
            source_sample_rate,
            source_channels,
        })
    }

    /// Stop the capture, take ownership of the buffered samples,
    /// downmix to mono, and resample to 16 kHz f32.
    pub fn stop(self) -> Result<Vec<f32>, DictationError> {
        // Dropping the stream tears down the cpal worker thread —
        // happens implicitly when `self` is consumed.
        drop(self.stream);

        let mut raw = std::mem::take(&mut *self.samples.lock());
        if self.source_channels > 1 {
            raw = downmix_to_mono(&raw, self.source_channels as usize);
        }

        if self.source_sample_rate == TARGET_SAMPLE_RATE {
            return Ok(raw);
        }
        resample_to_16k(&raw, self.source_sample_rate)
    }
}

/// Compose a cpal input stream that converts every incoming sample
/// type to `f32` and appends it to `buf`. cpal's callback is called
/// from a real-time audio thread; we only do a memcpy + lock here.
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buf: Arc<Mutex<Vec<f32>>>,
) -> Result<cpal::Stream, DictationError>
where
    T: cpal::SizedSample + cpal::Sample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let err_fn = |e| tracing::warn!(error = %e, "mic stream error");
    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut guard = buf.lock();
                guard.reserve(data.len());
                for &s in data {
                    // The `cpal::FromSample<T>` bound on `f32` lets
                    // us convert each input sample with the canonical
                    // `from_sample_` adapter from dasp_sample.
                    guard.push(<f32 as cpal::FromSample<T>>::from_sample_(s));
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| DictationError::Audio(format!("build_input_stream: {e}")))?;
    Ok(stream)
}

/// Average together every `channels`-sized frame to produce a mono
/// signal. Tail samples (incomplete final frame, very rare) are
/// dropped; whisper.cpp tolerates a few missing samples at the end.
fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for i in 0..frames {
        let off = i * channels;
        let mut acc = 0.0f32;
        for c in 0..channels {
            acc += interleaved[off + c];
        }
        out.push(acc / channels as f32);
    }
    out
}

/// Resample `input` from `src_rate` Hz to 16 kHz using a windowed sinc
/// kernel. We use `rubato`'s `FftFixedIn` (frequency-domain
/// resampler) because it's fast and quality is more than sufficient
/// for speech recognition.
fn resample_to_16k(input: &[f32], src_rate: u32) -> Result<Vec<f32>, DictationError> {
    use rubato::Resampler;

    if input.is_empty() {
        return Ok(Vec::new());
    }

    let chunk_size = 1024;
    let mut resampler = rubato::FftFixedIn::<f32>::new(
        src_rate as usize,
        TARGET_SAMPLE_RATE as usize,
        chunk_size,
        2,
        1,
    )
    .map_err(|e| DictationError::Audio(format!("rubato init: {e}")))?;

    let mut out: Vec<f32> = Vec::with_capacity(
        ((input.len() as u64) * (TARGET_SAMPLE_RATE as u64) / (src_rate as u64)) as usize + chunk_size,
    );
    let mut cursor = 0;
    while cursor + chunk_size <= input.len() {
        let chunk = &input[cursor..cursor + chunk_size];
        let chunks_in: [&[f32]; 1] = [chunk];
        let resampled = resampler
            .process(&chunks_in, None)
            .map_err(|e| DictationError::Audio(format!("rubato process: {e}")))?;
        if let Some(channel) = resampled.into_iter().next() {
            out.extend_from_slice(&channel);
        }
        cursor += chunk_size;
    }
    // Tail: pad with zeros so the resampler can flush its delay line,
    // then process one final chunk. Speech-recognition quality is
    // unaffected by ~64 ms of silence at the end.
    if cursor < input.len() {
        let mut tail = vec![0.0f32; chunk_size];
        let take = input.len() - cursor;
        tail[..take].copy_from_slice(&input[cursor..]);
        let chunks_in: [&[f32]; 1] = [&tail];
        if let Ok(resampled) = resampler.process(&chunks_in, None) {
            if let Some(channel) = resampled.into_iter().next() {
                out.extend_from_slice(&channel);
            }
        }
    }

    Ok(out)
}
