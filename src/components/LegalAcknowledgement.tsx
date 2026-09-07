import React, { useState } from 'react';
import { Linking, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors, font, radius, space } from '../theme';
import { LEGAL_LINKS, LEGAL_STATEMENT } from '../lib/legal';

export interface LegalPrompt {
  version: string;
  returning: boolean;
  busy: boolean;
  error: string | null;
}

export function LegalLinks() {
  const [error, setError] = useState<string | null>(null);
  const open = async (url: string) => {
    setError(null);
    try { await Linking.openURL(url); }
    catch { setError('Could not open the document. Please check your connection and try again.'); }
  };
  return <View>
    {LEGAL_LINKS.map(link => <TouchableOpacity key={link.url} accessibilityRole="link"
      accessibilityLabel={link.label} accessibilityHint="Opens in your browser"
      onPress={() => { void open(link.url); }} style={styles.link}>
      <Text style={styles.linkText}>{link.label}</Text>
    </TouchableOpacity>)}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

export function LegalAcknowledgement({ prompt, onContinue, onCancel, onDismiss }: {
  prompt: LegalPrompt | null; onContinue: () => void; onCancel: () => void; onDismiss: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const visible = !!prompt;
  React.useEffect(() => { setChecked(false); }, [prompt?.version, prompt?.returning, visible]);
  return <Modal supportedOrientations={['portrait', 'landscape']} visible={!!prompt} transparent animationType="none" onDismiss={onDismiss}
    onRequestClose={() => { if (!prompt?.busy) onCancel(); }}>
    <View style={styles.backdrop}>
      <View style={styles.card} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.content}>
          <Text accessibilityRole="header" style={styles.heading}>{prompt?.returning ? 'Review our legal documents' : 'Before you continue'}</Text>
          <Text style={styles.body}>{prompt?.returning
            ? 'Please acknowledge the current documents to continue with your account.'
            : 'Review these documents before signing in or creating an iTala account.'}</Text>
          <LegalLinks />
          <TouchableOpacity accessibilityRole="checkbox" accessibilityLabel={LEGAL_STATEMENT}
            accessibilityState={{ checked, disabled: prompt?.busy }} disabled={prompt?.busy}
            onPress={() => setChecked(value => !value)} style={styles.checkboxRow}>
            <View style={[styles.checkbox, checked && styles.checked]}>
              <Text style={styles.checkmark}>{checked ? '✓' : ''}</Text>
            </View>
            <Text style={[styles.body, { flex: 1 }]}>{LEGAL_STATEMENT}</Text>
          </TouchableOpacity>
          <Text style={styles.detail}>Document version: {prompt?.version}. Guest browsing does not require an account.</Text>
          {prompt?.error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{prompt.error}</Text> : null}
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: !checked || prompt?.busy, busy: prompt?.busy }}
            disabled={!checked || prompt?.busy} onPress={() => { if (checked && !prompt?.busy) onContinue(); }}
            style={[styles.button, { backgroundColor: colors.text, opacity: !checked || prompt?.busy ? 0.5 : 1 }]}>
            <Text style={{ fontFamily: font.bodyBold, color: colors.bg }}>{prompt?.busy ? 'Please wait…' : 'Agree and continue'}</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" disabled={prompt?.busy} onPress={onCancel}
            accessibilityState={{ disabled: prompt?.busy }} style={styles.button}>
            <Text style={styles.body}>{prompt?.returning ? 'Continue as guest' : 'Not now'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000C', justifyContent: 'center', alignItems: 'center', padding: space(5) },
  card: { width: '100%', maxWidth: 440, maxHeight: '90%', backgroundColor: colors.surface, borderRadius: radius.lg },
  content: { padding: space(5) },
  heading: { fontFamily: font.bodyBold, fontSize: 22, color: colors.text, marginBottom: 12 },
  body: { fontFamily: font.body, fontSize: 15, color: colors.text, lineHeight: 22 },
  detail: { fontFamily: font.body, fontSize: 12, color: colors.muted, marginVertical: 10 },
  link: { minHeight: 48, justifyContent: 'center' },
  linkText: { fontFamily: font.bodyMed, fontSize: 15, color: colors.brandTeal, textDecorationLine: 'underline' },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 12 },
  checkbox: { width: 26, height: 26, borderWidth: 2, borderColor: colors.muted, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: colors.brandTeal, borderColor: colors.brandTeal },
  checkmark: { color: colors.bg, fontSize: 18, fontWeight: 'bold' },
  error: { color: colors.red, fontFamily: font.body, fontSize: 14, marginVertical: 10 },
  button: { minHeight: 48, borderRadius: radius.md, padding: 14, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
});
