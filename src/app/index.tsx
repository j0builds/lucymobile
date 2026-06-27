import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import * as Notifications from 'expo-notifications';

import { act, getToken, onLoggedOut } from '@/lib/api';
import { hasBackend } from '@/lib/config';
import { loginWithGithub } from '@/lib/github';
import { parsePushData, registerForPush } from '@/lib/push';
import { craftReply } from '@/lib/response';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

type Turn = {
  id: string;
  you: string;
  lucy: string;
};

const TEAL = '#0F766E';
const TEAL_GLOW = '#14B8A6';
const INK = '#0A0A0A';
const PAPER = '#FAFAFA';
const MUTE = '#737373';

export default function ConverseScreen() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [interim, setInterim] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [signedIn, setSignedIn] = useState(false);

  const breathe = useSharedValue(1);
  const reactive = useSharedValue(0);
  const speakingPulse = useSharedValue(1);
  const scrollRef = useRef<ScrollView | null>(null);
  // When the backend asked to confirm, the next utterance re-calls act(text, true).
  const pendingConfirm = useRef<{ text: string } | null>(null);

  useSpeechRecognitionEvent('start', () => {
    setPhase('listening');
  });
  useSpeechRecognitionEvent('end', () => {
    setPhase((p) => (p === 'listening' ? 'idle' : p));
  });
  useSpeechRecognitionEvent('result', (event) => {
    const first = event.results[0]?.transcript ?? '';
    setInterim(first);
    if (event.isFinal && first.trim()) {
      handleFinal(first.trim());
    }
  });
  useSpeechRecognitionEvent('volumechange', (event) => {
    const v = Math.max(0, Math.min(10, event.value));
    reactive.value = withTiming(v / 10, { duration: 90 });
  });
  useSpeechRecognitionEvent('error', (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    setStatusLine(`mic: ${event.error}`);
    setPhase('idle');
  });

  useEffect(() => {
    breathe.value = withRepeat(
      withTiming(1.06, { duration: 2400, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    return () => cancelAnimation(breathe);
  }, [breathe]);

  useEffect(() => {
    if (phase === 'speaking') {
      speakingPulse.value = withRepeat(
        withTiming(1.14, { duration: 520, easing: Easing.inOut(Easing.quad) }),
        -1,
        true,
      );
    } else {
      cancelAnimation(speakingPulse);
      speakingPulse.value = withTiming(1, { duration: 220 });
    }
  }, [phase, speakingPulse]);

  // Track signed-in state from the token store; react to forced logout (failed
  // token refresh) emitted by api.request().
  useEffect(() => {
    let mounted = true;
    getToken().then((t) => {
      if (mounted) setSignedIn(!!t);
    });
    const unsub = onLoggedOut(() => {
      setSignedIn(false);
      setStatusLine('signed out — sign in again');
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  // After sign-in, register this device for push. Re-runs when signedIn flips on.
  useEffect(() => {
    if (!signedIn) return;
    registerForPush().catch(() => {
      // non-fatal: app still works without push.
    });
  }, [signedIn]);

  // Route taps on Lucy push notifications. data: { type, id }.
  useEffect(() => {
    const handle = (data: unknown) => {
      const push = parsePushData(data);
      if (!push) return;
      if (push.type === 'reinforce') {
        // A recall prompt — surface it and let the user speak the answer.
        setStatusLine(`recall: ${push.id} — tap the orb to respond`);
        // TODO: open a dedicated recall screen with the prompt body once routing
        // beyond the single screen exists.
      } else {
        // needs_you / interception — log for now; needs full nav to land on a
        // specific item screen.
        setStatusLine(`${push.type}: ${push.id}`);
        // TODO: navigate to the item once multi-screen routing is wired.
      }
    };

    // Cold start: app opened from a notification.
    Notifications.getLastNotificationResponseAsync().then(
      (response: Notifications.NotificationResponse | null) => {
        if (response) handle(response.notification.request.content.data);
      },
    );
    // Warm: user taps a notification while the app is running/backgrounded.
    const sub = Notifications.addNotificationResponseReceivedListener(
      (response: Notifications.NotificationResponse) => {
        handle(response.notification.request.content.data);
      },
    );
    return () => sub.remove();
  }, []);

  const onSignInGithub = useCallback(async () => {
    setStatusLine('opening github…');
    const res = await loginWithGithub();
    if (res.ok) {
      setSignedIn(true);
      setStatusLine('signed in');
    } else if (res.reason === 'cancelled') {
      setStatusLine('sign-in cancelled');
    } else if (res.reason === 'no-backend') {
      setStatusLine('local-only — no LUCY_API_URL yet');
    } else if (res.reason === 'no-tokens') {
      setStatusLine('sign-in incomplete');
    } else {
      setStatusLine('sign-in failed');
    }
  }, []);

  const orbStyle = useAnimatedStyle(() => {
    const base = phase === 'listening' ? 1 + reactive.value * 0.32 : breathe.value;
    return { transform: [{ scale: base * speakingPulse.value }] };
  });

  const haloStyle = useAnimatedStyle(() => {
    const intensity =
      phase === 'listening'
        ? 0.25 + reactive.value * 0.55
        : phase === 'speaking'
          ? 0.45
          : phase === 'thinking'
            ? 0.35
            : 0.18;
    return { opacity: intensity };
  });

  const startListening = useCallback(async () => {
    setStatusLine(null);
    setInterim('');
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setStatusLine('mic permission denied');
      return;
    }
    if (!cameraOn) {
      const cp = camPerm?.granted ? camPerm : await requestCamPerm();
      if (cp?.granted) setCameraOn(true);
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: false,
      requiresOnDeviceRecognition: false,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
    });
  }, []);

  const stopListening = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
  }, []);

  const speakBack = useCallback((text: string) => {
    setPhase('speaking');
    Speech.speak(text, {
      language: 'en-US',
      pitch: 1.05,
      rate: 0.98,
      onDone: () => {
        setPhase('idle');
        setTimeout(() => {
          startListening();
        }, 350);
      },
      onStopped: () => setPhase('idle'),
      onError: () => setPhase('idle'),
    });
  }, [startListening]);

  const handleFinal = useCallback(
    async (text: string) => {
      setPhase('thinking');
      setInterim('');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      // Resolve a pending confirmation: this utterance answers the prior prompt.
      const confirming = pendingConfirm.current;
      pendingConfirm.current = null;

      // Primary path: /v1/mobile/act gives us the line to speak back.
      const result = await act(
        confirming ? confirming.text : text,
        confirming ? true : undefined,
      );

      let reply: string;
      if (result.ok) {
        setStatusLine(null);
        reply = result.data.spokenReply || craftReply(text);
        // Server wants a yes/no before acting — keep the original text so the
        // next utterance re-calls act(text, true).
        if (result.data.needsConfirm) {
          pendingConfirm.current = { text: confirming ? confirming.text : text };
        }
      } else {
        // Degraded paths: surface why, fall back to the offline stub reply.
        if (result.reason === 'no-backend') {
          setStatusLine('local-only — no LUCY_API_URL yet');
        } else if (result.reason === 'no-key') {
          setStatusLine('not signed in');
        } else {
          setStatusLine('backend issue');
        }
        reply = craftReply(text);
      }

      const turn: Turn = {
        id: `${Date.now()}`,
        you: text,
        lucy: reply,
      };
      setTurns((prev) => [...prev, turn]);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollToEnd({ animated: true });
      });
      speakBack(reply);
    },
    [speakBack],
  );

  const onPressOrb = () => {
    if (phase === 'idle') startListening();
    else if (phase === 'listening') stopListening();
    else if (phase === 'speaking') {
      Speech.stop();
      setPhase('idle');
    }
  };

  const phaseLabel =
    phase === 'listening'
      ? 'listening'
      : phase === 'thinking'
        ? 'thinking'
        : phase === 'speaking'
          ? 'speaking'
          : turns.length === 0
            ? 'tap to begin'
            : 'tap to speak';

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['#0B0F0E', '#0A0A0A', '#000000']}
        locations={[0, 0.6, 1]}
        style={StyleSheet.absoluteFillObject}
      />
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.brandDot} />
            <Text style={styles.brand}>lucy</Text>
          </View>
          <View style={styles.headerRight}>
            {cameraOn && (
              <View style={styles.camWrap}>
                <CameraView facing="front" style={styles.cam} mirror />
                <View style={styles.camRing} pointerEvents="none" />
              </View>
            )}
            <View
              style={[styles.statusDot, hasBackend ? styles.dotOn : styles.dotOff]}
            />
          </View>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.log}
          contentContainerStyle={styles.logInner}
          showsVerticalScrollIndicator={false}>
          {turns.length === 0 && phase === 'idle' && (
            <View style={styles.welcome}>
              <Text style={styles.welcomeTitle}>say anything.</Text>
              <Text style={styles.welcomeSub}>
                lucy listens, lands it in your brain, and talks back.
              </Text>
              {hasBackend && !signedIn && (
                <Pressable
                  onPress={onSignInGithub}
                  style={styles.ghButton}
                  hitSlop={8}>
                  <Text style={styles.ghButtonText}>sign in with github</Text>
                </Pressable>
              )}
            </View>
          )}

          {turns.map((t) => (
            <View key={t.id} style={styles.turn}>
              <Text style={styles.youLabel}>you</Text>
              <Text style={styles.youText}>{t.you}</Text>
              <Text style={styles.lucyLabel}>lucy</Text>
              <Text style={styles.lucyText}>{t.lucy}</Text>
            </View>
          ))}

          {interim.length > 0 && phase === 'listening' && (
            <View style={styles.turn}>
              <Text style={styles.youLabel}>you</Text>
              <Text style={[styles.youText, styles.interim]}>{interim}</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.controls}>
          <View style={styles.orbWrap}>
            <Animated.View style={[styles.halo, haloStyle]} />
            <Pressable onPress={onPressOrb} hitSlop={24} style={styles.orbHit}>
              <Animated.View
                style={[
                  styles.orb,
                  phase === 'listening' && styles.orbListening,
                  phase === 'thinking' && styles.orbThinking,
                  phase === 'speaking' && styles.orbSpeaking,
                  orbStyle,
                ]}>
                <View style={styles.orbInner} />
              </Animated.View>
            </Pressable>
          </View>
          <Text style={styles.phaseLabel}>{phaseLabel}</Text>
          <Text style={styles.status}>
            {statusLine ?? (hasBackend ? 'connected' : 'local-only mode')}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: INK },
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 8,
    paddingBottom: 4,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brandDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: TEAL,
  },
  brand: {
    color: PAPER,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  statusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  camWrap: {
    width: 60,
    height: 60,
    borderRadius: 30,
    overflow: 'hidden',
    backgroundColor: '#0E1413',
  },
  cam: {
    width: 60,
    height: 60,
  },
  camRing: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: 'rgba(20, 184, 166, 0.45)',
    borderRadius: 30,
  },
  dotOn: { backgroundColor: '#22A06B' },
  dotOff: { backgroundColor: '#3F3F46' },
  log: { flex: 1 },
  logInner: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 20,
    gap: 22,
  },
  welcome: {
    flex: 1,
    justifyContent: 'center',
    paddingTop: 60,
    gap: 10,
  },
  welcomeTitle: {
    color: PAPER,
    fontSize: 30,
    fontWeight: '600',
    letterSpacing: -0.6,
  },
  welcomeSub: {
    color: MUTE,
    fontSize: 16,
    lineHeight: 22,
  },
  ghButton: {
    marginTop: 22,
    alignSelf: 'flex-start',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(20, 184, 166, 0.45)',
    backgroundColor: '#0E1413',
  },
  ghButtonText: {
    color: '#E5F3F1',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  turn: { gap: 6 },
  youLabel: {
    color: MUTE,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  youText: {
    color: PAPER,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '500',
    letterSpacing: -0.2,
  },
  interim: {
    color: '#A3A3A3',
  },
  lucyLabel: {
    color: TEAL_GLOW,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: 6,
  },
  lucyText: {
    color: '#E5F3F1',
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '500',
    letterSpacing: -0.2,
  },
  controls: {
    alignItems: 'center',
    paddingBottom: 22,
    paddingTop: 6,
    gap: 10,
  },
  orbWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 200,
    height: 200,
  },
  halo: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: TEAL,
    opacity: 0.2,
  },
  orbHit: { padding: 8 },
  orb: {
    width: 144,
    height: 144,
    borderRadius: 72,
    backgroundColor: '#0E1413',
    borderWidth: 1.5,
    borderColor: 'rgba(20, 184, 166, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: TEAL_GLOW,
    shadowOpacity: 0.55,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 0 },
  },
  orbListening: {
    borderColor: PAPER,
    shadowColor: PAPER,
    shadowOpacity: 0.65,
  },
  orbThinking: {
    borderColor: TEAL_GLOW,
    backgroundColor: '#0A1F1C',
  },
  orbSpeaking: {
    borderColor: TEAL_GLOW,
    backgroundColor: TEAL,
    shadowColor: TEAL_GLOW,
    shadowOpacity: 0.85,
  },
  orbInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: TEAL_GLOW,
    opacity: 0.85,
  },
  phaseLabel: {
    color: PAPER,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  status: {
    color: MUTE,
    fontSize: 12,
    letterSpacing: 0.3,
  },
});
