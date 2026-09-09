import React, { useState } from 'react';
import { Linking, Modal, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors, font, radius, space } from '../theme';
import { LEGAL_LINKS, LEGAL_STATEMENT } from '../lib/legal';

export interface LegalPrompt {
  version: string;
  returning: boolean;
  busy: boolean;
  error: string | null;
}

export function LegalLinks({ inline = false, compact = false }: { inline?: boolean; compact?: boolean } = {}) {
  const [error, setError] = useState<string | null>(null);
  const open = async (url: string) => {
    setError(null);
    try { await Linking.openURL(url); }
    catch { setError('Could not open the document. Please check your connection and try again.'); }
  };
  return <View>
    {inline ? <Text style={styles.agreement}>
      {LEGAL_STATEMENT.split(/(Terms of Use|Privacy Policy|Content Policy)/).map((part, index) => {
        const link = LEGAL_LINKS.find(item => item.label === part);
        return link ? <Text key={link.url} accessibilityRole="link"
          accessibilityLabel={link.label} accessibilityHint="Opens in your browser"
          onPress={() => { void open(link.url); }} style={styles.inlineLink}>{part}</Text>
          : <Text key={index}>{part}</Text>;
      })}
    </Text> : LEGAL_LINKS.map((link, index) => <TouchableOpacity key={link.url} accessibilityRole="link"
      accessibilityLabel={link.label} accessibilityHint="Opens in your browser"
      onPress={() => { void open(link.url); }} style={[styles.link, compact && styles.compactLink,
        compact && index > 0 && styles.divider]}>
      <Text style={[styles.linkText, compact && styles.compactText]}>{link.label}</Text>
      {compact ? <Text accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.externalIcon}>↗</Text> : null}
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
          <View style={styles.checkboxRow}>
            <TouchableOpacity accessibilityRole="checkbox" accessibilityLabel={LEGAL_STATEMENT}
            accessibilityState={{ checked, disabled: prompt?.busy }} disabled={prompt?.busy}
            onPress={() => setChecked(value => !value)} style={styles.checkboxTarget}>
              <View style={[styles.checkbox, checked && styles.checked]}>
                <Text style={styles.checkmark}>{checked ? '✓' : ''}</Text>
              </View>
            </TouchableOpacity>
            <View style={styles.agreementContainer}>
              <LegalLinks inline />
            </View>
          </View>
          {prompt?.error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{prompt.error}</Text> : null}
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: !checked || prompt?.busy, busy: prompt?.busy }}
            disabled={!checked || prompt?.busy} onPress={() => { if (checked && !prompt?.busy) onContinue(); }}
            style={[styles.button, { backgroundColor: colors.text, opacity: !checked || prompt?.busy ? 0.5 : 1 }]}>
            <Text style={{ fontFamily: font.bodyBold, color: colors.bg }}>{prompt?.busy ? 'Please wait…' : 'Agree and continue'}</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" disabled={prompt?.busy} onPress={onCancel}
            accessibilityState={{ disabled: prompt?.busy }} style={styles.button}>
            <Text style={styles.body}>Sign out and browse as guest</Text>
          </TouchableOpacity>
          <Text style={styles.detail}>Version {prompt?.version}</Text>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000C', justifyContent: 'center', alignItems: 'center', padding: space(5) },
  card: { width: '100%', maxWidth: 400, maxHeight: '90%', backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  content: { padding: space(6) },
  heading: { fontFamily: font.bodyBold, fontSize: 23, color: colors.text, marginBottom: 20 },
  body: { fontFamily: font.body, fontSize: 15, color: colors.text, lineHeight: 22 },
  detail: { fontFamily: font.body, fontSize: 12, color: colors.muted, textAlign: 'center', marginTop: 12 },
  link: { minHeight: 48, justifyContent: 'center' },
  linkText: { fontFamily: font.bodyMed, fontSize: 15, color: colors.brandTeal, textDecorationLine: 'underline' },
  compactLink: { minHeight: Platform.OS === 'android' ? 48 : 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, gap: 12 },
  compactText: { flex: 1, textDecorationLine: 'none' },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  externalIcon: { fontSize: 18, color: colors.muted },
  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginBottom: 14 },
  checkboxTarget: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -9, marginTop: -9 },
  agreementContainer: { flex: 1 },
  agreement: { fontFamily: font.body, fontSize: 16, color: colors.text, lineHeight: 26 },
  inlineLink: { color: colors.brandTeal, textDecorationLine: 'underline' },
  checkbox: { width: 26, height: 26, borderWidth: 2, borderColor: colors.muted, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: colors.brandTeal, borderColor: colors.brandTeal },
  checkmark: { color: colors.bg, fontSize: 18, fontWeight: 'bold' },
  error: { color: colors.red, fontFamily: font.body, fontSize: 14, marginVertical: 10 },
  button: { minHeight: 48, borderRadius: radius.md, padding: 14, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
});
