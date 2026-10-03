import React, { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { Button, Txt } from './ui';
import { DefaultResultForm } from './DefaultResultModal';
import { Team } from '../types';
import { colors, radius, space } from '../theme';

export default function FinishLevelModal({ home, away, score, period, onCancel, onAddPeriod, onFinish, onDefaultConfirm }:
  { home: Team; away: Team; score: number; period: number; onCancel: () => void;
    onAddPeriod?: () => void; onFinish: () => void;
    onDefaultConfirm?: (winnerTeamId: string, score: number) => void }) {
  const [showDefault, setShowDefault] = useState(false);
  const back = () => setShowDefault(false);
  const close = showDefault ? back : onCancel;
  return <Modal transparent animationType="fade" onRequestClose={close}
    supportedOrientations={['portrait', 'landscape']}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: '#000B' }}>
      <Pressable onPress={close} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6) }}>
        <Pressable onPress={() => {}} style={{ width: '100%', maxWidth: 400, maxHeight: '100%',
          backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1,
          borderColor: colors.line, overflow: 'hidden' }}>
          {showDefault && onDefaultConfirm ? <DefaultResultForm home={home} away={away}
            onCancel={back} onConfirm={onDefaultConfirm} /> :
            <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ padding: space(5) }}>
              <Txt k="h2">Scores are level</Txt>
              <Txt k="body" style={{ marginTop: space(2) }}>{home.name} {score} — {score} {away.name}</Txt>
              <Txt k="body" color={colors.muted} style={{ marginTop: space(2) }}>
                Basketball goes to overtime rather than ending level. {onAddPeriod
                  ? `Add period ${period + 1} to play it out, or finish now — a level game counts towards neither team's record.`
                  : `This is the last period the tracker allows, so finishing now records a game that counts towards neither team's record.`}
              </Txt>
              <View style={{ gap: 10, marginTop: space(4) }}>
                {onAddPeriod && <Button title={`Add period ${period + 1}`} onPress={onAddPeriod} />}
                {onDefaultConfirm && <Button title="Default/Forfeit" kind="ghost" onPress={() => setShowDefault(true)} />}
                <Button title="Finish level" kind="danger" onPress={onFinish} />
                <Button title="Cancel" kind="ghost" onPress={onCancel} />
              </View>
            </ScrollView>}
        </Pressable>
      </Pressable>
    </KeyboardAvoidingView>
  </Modal>;
}
