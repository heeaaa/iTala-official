import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button, Field, Sheet, Txt } from '../ui/index';
import { colors, space } from '../theme';
import { useAdmin } from '../store/AdminProvider';

/**
 * The admin gate. The copy tells the user how many tries are left and how long
 * a lockout has to run, because the server now says so rather than returning a
 * bare boolean.
 */
export function PasswordSheet({
  visible,
  message,
  onClose,
  onSuccess,
}: {
  visible: boolean;
  message?: string;
  onClose: () => void;
  onSuccess?: () => void;
}): React.JSX.Element {
  const { unlock, busy } = useAdmin();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Cleared every time it opens, so a half-typed attempt never lingers.
  useEffect(() => {
    if (visible) {
      setPassword('');
      setError(null);
    }
  }, [visible]);

  const submit = async (): Promise<void> => {
    const result = await unlock(password);
    if (result.ok) {
      setPassword('');
      onSuccess?.();
      onClose();
      return;
    }
    setError(result.message);
  };

  return (
    <Sheet visible={visible} title="Admin access" onClose={onClose}>
      <Txt color={colors.muted} style={{ marginBottom: space(3) }}>
        {message ?? 'Enter the admin password to unlock stat tracking.'}
      </Txt>
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoFocus
        error={Boolean(error)}
        onSubmitEditing={() => void submit()}
      />
      {error ? (
        <Txt color={colors.red} style={{ marginBottom: space(3) }}>
          {error}
        </Txt>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space(3) }}>
        <Button title="Cancel" kind="ghost" onPress={onClose} style={{ flex: 1 }} />
        <Button
          title={busy ? 'Unlocking...' : 'Unlock'}
          disabled={busy}
          onPress={() => void submit()}
          style={{ flex: 1 }}
        />
      </View>
    </Sheet>
  );
}
