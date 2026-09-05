import React, { useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Button, Card, Field, Screen, Txt } from '../components/ui';
import { REPORT_REASONS, ReportReason, submitContentReport, describeContentReportError } from '../lib/contentReports';
import { ScreenProps } from '../navigation';
import { uid } from '../lib/format';
import { colors, radius, space } from '../theme';

export default function ReportContentScreen({ route, navigation }: ScreenProps<'ReportContent'>) {
  const { recordType, recordId, leagueId, teamId, label } = route.params;
  const pendingReport = useRef<{ payload: string; id: string } | null>(null);
  const submitting = useRef(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [explanation, setExplanation] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reference, setReference] = useState('');

  const submit = async () => {
    if (!reason || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const input = { recordType, recordId, leagueId, teamId, reason, explanation, contactEmail };
      const payload = JSON.stringify(input);
      if (pendingReport.current?.payload !== payload) {
        pendingReport.current = { payload, id: uid() + uid() };
      }
      const receipt = await submitContentReport(input, pendingReport.current.id);
      setReference(receipt.reference);
    } catch (e) {
      setError(describeContentReportError(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  if (reference) {
    return (
      <Screen scroll>
        <Card>
          <Txt k="h1" color={colors.brandTeal}>Report received</Txt>
          <Txt k="body" style={{ marginTop: space(3) }}>
            Thank you. iTala’s privacy contacts can now review this report.
          </Txt>
          <Txt k="label" style={{ marginTop: space(5) }}>Reference number</Txt>
          <Txt k="h2" color={colors.accent} style={{ marginTop: 4 }}>{reference}</Txt>
          <Txt k="body" color={colors.muted} style={{ marginTop: space(3) }}>
            Keep this number if you contact abejohanna@gmail.com or abejoharold@gmail.com about the report.
          </Txt>
        </Card>
        <Button title="Done" onPress={() => navigation.goBack()} style={{ marginTop: space(4) }} />
      </Screen>
    );
  }

  return (
    <Screen scroll keyboardShouldPersistTaps="handled">
      <Txt k="body" color={colors.muted}>
        Report information about {label}. This complements the existing email privacy-request process.
      </Txt>
      <Txt k="label" style={{ marginTop: space(5), marginBottom: space(2) }}>What is the concern?</Txt>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        {REPORT_REASONS.map((item, index) => {
          const selected = reason === item;
          return (
            <Pressable
              key={item}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => setReason(item)}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14,
                borderTopWidth: index ? 1 : 0, borderTopColor: colors.line,
                backgroundColor: selected ? colors.accentDim : 'transparent',
              }}>
              <View style={{
                width: 20, height: 20, borderRadius: 10, borderWidth: 2,
                borderColor: selected ? colors.brandTeal : colors.muted,
                alignItems: 'center', justifyContent: 'center',
              }}>
                {selected ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brandTeal }} /> : null}
              </View>
              <Txt k="body" style={{ flex: 1 }}>{item}</Txt>
            </Pressable>
          );
        })}
      </Card>

      <View style={{ marginTop: space(4), marginBottom: space(3) }}>
        <Txt k="label" style={{ marginBottom: 6 }}>Explanation (optional)</Txt>
        <TextInput
          value={explanation}
          onChangeText={setExplanation}
          maxLength={2000}
          multiline
          textAlignVertical="top"
          accessibilityLabel="Explanation (optional)"
          placeholder="Tell us what should be reviewed or removed"
          placeholderTextColor={colors.muted}
          style={{
            minHeight: 112, backgroundColor: colors.surface, borderRadius: radius.md,
            borderWidth: 1, borderColor: colors.line, color: colors.text,
            paddingHorizontal: 14, paddingVertical: 12, fontSize: 16,
          }}
        />
      </View>
      <Field
        label="Contact email (optional)"
        value={contactEmail}
        onChangeText={setContactEmail}
        placeholder="Only if you want status updates"
      />
      <Txt k="body" color={colors.muted} style={{ fontSize: 12, marginBottom: space(4) }}>
        You do not need to provide your name or contact details. The report automatically includes the content identifiers, your app session ID and submission time.
      </Txt>
      {error ? <Txt k="body" color={colors.red} style={{ marginBottom: space(3) }}>{error}</Txt> : null}
      <Button title={busy ? 'Submitting…' : 'Submit report'} onPress={() => void submit()} disabled={!reason || busy} />
    </Screen>
  );
}
