import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Txt } from './ui';
import { League, ConnectLinkState } from '../types';
import { refreshConnectLinkState } from '../sync/connectSchedule';
import { colors, space } from '../theme';

export default function ConnectLinkSettings({ league, onUpdate }: {
  league: League; onUpdate: (state: ConnectLinkState) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(false);
  const sequence = useRef(0);
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;
  const check = async (force: boolean) => {
    const request = ++sequence.current;
    setChecking(true); setFailed(false);
    try {
      const state = await refreshConnectLinkState(league.id, force);
      if (alive.current && request === sequence.current) updateRef.current(state);
    } catch { if (alive.current && request === sequence.current) setFailed(true); }
    finally { if (alive.current && request === sequence.current) setChecking(false); }
  };
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    alive.current = true;
    const requests = sequence;
    void checkRef.current(false);
    return () => { alive.current = false; requests.current++; };
  }, [league.id]);
  const linked = !!league.connectLink?.events.length;
  return <View style={{ marginBottom: space(4), borderBottomWidth: 1, borderColor: colors.line, paddingBottom: space(3) }}>
    <Txt k="h2">iTala Connect schedule</Txt>
    <Txt k="body" color={colors.muted} style={{ marginTop: space(2) }}>
      {linked ? league.connectLink!.events.map(event => event.name).join(' · ')
        : league.connectLink ? 'No published schedule linked. Games can be started as usual.'
          : 'Link not checked yet. Games can be started as usual.'}
    </Txt>
    {league.connectLink && <Txt k="body" color={colors.muted} style={{ marginTop: space(2), fontSize: 12 }}>
      Last checked: {new Date(league.connectLink.checkedAt).toLocaleString()}
    </Txt>}
    {failed && <Txt k="body" color={colors.muted} style={{ marginTop: space(2), fontSize: 13 }}>
      Couldn’t refresh the Connect link. The previous status is unchanged.
    </Txt>}
    <Pressable accessibilityRole="button" accessibilityLabel="Check for a Connect schedule"
      accessibilityState={{ disabled: checking }} disabled={checking} onPress={() => void check(true)}
      style={{ minHeight: 44, paddingVertical: space(2), justifyContent: 'center', alignSelf: 'flex-start', maxWidth: '100%' }}>
      <Txt k="body" color={colors.brandTeal} style={{ textDecorationLine: 'underline' }}>
        {checking ? 'Checking Connect link…' : 'Check for a schedule'}
      </Txt>
    </Pressable>
  </View>;
}
