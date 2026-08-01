
import { isStandaloneWebAppMode } from './chat-window.js';

export function isIOSDeviceRuntime(runtime = {}) {
    const nav = runtime.navigator ?? (typeof navigator !== 'undefined' ? navigator : null);
    if (!nav) return false;
    const userAgent = String(nav.userAgent || '');
    if (/iPad|iPhone/.test(userAgent)) return true;
    return nav.platform === 'MacIntel' && Number(nav.maxTouchPoints || 0) > 1;
}

export function resolveSpeechRecognitionCtor(runtime = {}) {
    const win = runtime.window ?? (typeof window !== 'undefined' ? window : null);
    if (!win) return null;
    return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function getSpeechInputSupport(runtime = {}) {
    const win = runtime.window ?? (typeof window !== 'undefined' ? window : null);
    const secureContext = typeof runtime.secureContext === 'boolean'
        ? runtime.secureContext
        : Boolean(win?.isSecureContext);
    const standalone = isStandaloneWebAppMode(runtime);
    const ios = isIOSDeviceRuntime(runtime);
    const recognitionCtor = resolveSpeechRecognitionCtor(runtime);

    if (!secureContext) {
        return {
            mode: 'unavailable',
            showButton: false,
            canStart: false,
            reason: 'secure-context-required',
            title: 'Voice input requires HTTPS',
            detail: 'Native browser speech input needs a secure context (HTTPS or localhost).',
            recognitionCtor: null,
            ios,
            standalone,
            secureContext,
        };
    }

    if (ios && standalone) {
        return {
            mode: 'fallback',
            showButton: true,
            canStart: false,
            reason: 'ios-standalone-fallback',
            title: 'Use keyboard dictation',
            detail: 'Speech input is intentionally downgraded in iPhone/iPad standalone web apps because browser-native recognition is not reliable there. Focus the compose box and use the keyboard dictation mic instead.',
            recognitionCtor,
            ios,
            standalone,
            secureContext,
        };
    }

    if (!recognitionCtor) {
        if (ios) {
            return {
                mode: 'fallback',
                showButton: true,
                canStart: false,
                reason: 'ios-keyboard-dictation',
                title: 'Use keyboard dictation',
                detail: 'This browser does not expose native in-page speech recognition here. Focus the compose box and use the keyboard dictation mic instead.',
                recognitionCtor: null,
                ios,
                standalone,
                secureContext,
            };
        }

        return {
            mode: 'unavailable',
            showButton: false,
            canStart: false,
            reason: 'unsupported',
            title: 'Voice input unavailable',
            detail: 'This browser does not expose native speech recognition in this context.',
            recognitionCtor: null,
            ios,
            standalone,
            secureContext,
        };
    }

    return {
        mode: 'native',
        showButton: true,
        canStart: true,
        reason: 'supported',
        title: 'Start voice input',
        detail: ios
            ? 'Browser-native speech input is available here, but Safari/WebKit reliability may still vary.'
            : 'Browser-native speech input is available.',
        recognitionCtor,
        ios,
        standalone,
        secureContext,
    };
}

export function mergeSpeechComposeText(baseText, finalTranscript = '', interimTranscript = '') {
    const base = String(baseText || '');
    const finalText = String(finalTranscript || '').trim();
    const interimText = String(interimTranscript || '').trim();
    const speechText = [finalText, interimText].filter(Boolean).join(' ').trim();
    if (!speechText) return base;
    if (!base) return speechText;
    const separator = /[\s\n]$/.test(base) ? '' : ' ';
    return `${base}${separator}${speechText}`;
}

export function extractSpeechRecognitionText(results, startIndex = 0) {
    let finalText = '';
    let interimText = '';
    const list = results && typeof results.length === 'number' ? results : [];

    for (let index = Math.max(0, startIndex); index < list.length; index += 1) {
        const result = list[index];
        if (!result || !result[0]) continue;
        const transcript = String(result[0].transcript || '').trim();
        if (!transcript) continue;
        if (result.isFinal) {
            finalText = `${finalText} ${transcript}`.trim();
        } else {
            interimText = `${interimText} ${transcript}`.trim();
        }
    }

    return { finalText, interimText };
}

export function describeSpeechRecognitionError(errorCode, support = null) {
    const code = String(errorCode || '').trim().toLowerCase();
    switch (code) {
        case 'not-allowed':
        case 'service-not-allowed':
            return support?.ios
                ? 'Microphone or speech-recognition permission was denied. On iPhone/iPad, using keyboard dictation may be more reliable.'
                : 'Microphone or speech-recognition permission was denied by the browser.';
        case 'no-speech':
            return 'No speech was detected. Try again and speak after the listening indicator appears.';
        case 'audio-capture':
            return 'The browser could not access a microphone for speech recognition.';
        case 'network':
            return 'The browser speech-recognition service reported a network or service failure.';
        case 'aborted':
            return 'Voice input was stopped.';
        default:
            return code ? `Voice input failed (${code}).` : 'Voice input failed.';
    }
}
