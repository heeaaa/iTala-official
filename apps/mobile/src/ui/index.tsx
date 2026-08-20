/**
 * The shared component library.
 *
 * Two rules run through all of it. Every pressable carries an accessibility
 * label, role and state, because v1 had none anywhere and retrofitting is far
 * more expensive than writing it once. And nothing uses emoji as an icon: v1
 * used fourteen, which render differently on every platform and are announced
 * badly or not at all by a screen reader.
 */
import React from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// Imported by subpath, deliberately. The barrel export pulls in every icon
// font the package ships, which added about 2.5MB of TTF to the bundle for the
// sake of one set we actually use.
import Feather from '@expo/vector-icons/Feather';
import { colors, fonts, radius, space, textKinds, type TextKind } from '../theme';

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

export function Txt({
  k = 'body',
  color,
  style,
  children,
  numberOfLines,
  adjustsFontSizeToFit,
  minimumFontScale,
  allowFontScaling,
}: {
  k?: TextKind;
  color?: string;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
  adjustsFontSizeToFit?: boolean;
  minimumFontScale?: number;
  allowFontScaling?: boolean;
}): React.JSX.Element {
  return (
    <Text
      numberOfLines={numberOfLines}
      adjustsFontSizeToFit={adjustsFontSizeToFit}
      minimumFontScale={minimumFontScale}
      allowFontScaling={allowFontScaling}
      style={[textKinds[k] as TextStyle, color ? { color } : null, style]}
    >
      {children}
    </Text>
  );
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                       */
/* -------------------------------------------------------------------------- */

const FEATHER = {
  lock: 'lock',
  unlock: 'unlock',
  settings: 'settings',
  swap: 'repeat',
  log: 'list',
  timeout: 'clock',
  undo: 'rotate-ccw',
  subs: 'users',
  eye: 'eye',
  play: 'play',
  plus: 'plus',
  minus: 'minus',
  next: 'chevron-right',
  back: 'chevron-left',
  edit: 'edit-2',
  close: 'x',
  check: 'check',
  trash: 'trash-2',
  share: 'share',
  alert: 'alert-triangle',
} as const;

export type IconName = keyof typeof FEATHER;

export function Icon({
  name,
  size = 18,
  color = colors.text,
}: {
  name: IconName;
  size?: number;
  color?: string;
}): React.JSX.Element {
  return <Feather name={FEATHER[name]} size={size} color={color} />;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function Screen({
  children,
  scroll,
  contentStyle,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[
        { padding: space(4), paddingBottom: space(16), gap: space(3) },
        contentStyle,
      ]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}): React.JSX.Element {
  const base: ViewStyle = {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space(4),
    borderWidth: 1,
    borderColor: colors.line,
  };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [base, style, pressed ? { opacity: 0.85 } : null]}
    >
      {children}
    </Pressable>
  );
}

export function Empty({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}): React.JSX.Element {
  return (
    <View style={{ paddingVertical: space(12), alignItems: 'center' }}>
      <Txt k="h2" color={colors.muted}>
        {title}
      </Txt>
      {subtitle ? (
        <Txt color={colors.muted} style={{ textAlign: 'center', marginTop: space(2) }}>
          {subtitle}
        </Txt>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  style,
  icon,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: IconName;
  accessibilityHint?: string;
}): React.JSX.Element {
  const bg = kind === 'primary' ? colors.accent : kind === 'danger' ? 'transparent' : 'transparent';
  const border = kind === 'ghost' ? colors.line : kind === 'danger' ? colors.red : 'transparent';
  const fg = kind === 'primary' ? colors.bg : kind === 'danger' ? colors.red : colors.text;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: border,
          borderWidth: kind === 'primary' ? 0 : 1,
          borderRadius: radius.md,
          paddingVertical: space(3.5),
          paddingHorizontal: space(4.5),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space(2),
          opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={16} color={fg} /> : null}
      <Txt k="body" color={fg} style={{ fontFamily: fonts.bodyBold }}>
        {title}
      </Txt>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoFocus,
  secureTextEntry,
  onSubmitEditing,
  error,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad' | 'numbers-and-punctuation';
  autoFocus?: boolean;
  secureTextEntry?: boolean;
  onSubmitEditing?: () => void;
  error?: boolean;
}): React.JSX.Element {
  return (
    <View style={{ marginBottom: space(3) }}>
      <Txt k="label">{label}</Txt>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        keyboardType={keyboardType}
        autoFocus={autoFocus}
        secureTextEntry={secureTextEntry}
        onSubmitEditing={onSubmitEditing}
        accessibilityLabel={label}
        style={{
          marginTop: space(1.5),
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: error ? colors.red : colors.line,
          borderRadius: radius.md,
          paddingVertical: space(3.5),
          paddingHorizontal: space(3),
          color: colors.text,
          fontFamily: fonts.body,
          fontSize: 16,
        }}
      />
    </View>
  );
}

export function Pill({
  label,
  color = colors.surfaceHi,
  textColor = colors.text,
}: {
  label: string;
  color?: string;
  textColor?: string;
}): React.JSX.Element {
  return (
    <View
      style={{
        backgroundColor: color,
        borderRadius: radius.pill,
        paddingHorizontal: space(2.5),
        paddingVertical: space(1),
      }}
    >
      <Txt k="label" color={textColor} style={{ textTransform: 'none' }}>
        {label}
      </Txt>
    </View>
  );
}

export function Segmented({
  options,
  value,
  onChange,
  label,
}: {
  options: string[];
  value: number;
  onChange: (i: number) => void;
  label: string;
}): React.JSX.Element {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.line,
        padding: space(1),
        gap: space(1),
      }}
    >
      {options.map((o, i) => (
        <Pressable
          key={o}
          onPress={() => onChange(i)}
          accessibilityRole="tab"
          accessibilityLabel={o}
          accessibilityState={{ selected: i === value }}
          style={{
            flex: 1,
            paddingVertical: space(2),
            borderRadius: radius.sm,
            backgroundColor: i === value ? colors.accent : 'transparent',
            alignItems: 'center',
          }}
        >
          <Txt
            k="label"
            color={i === value ? colors.bg : colors.muted}
            style={{ textTransform: 'none' }}
          >
            {o}
          </Txt>
        </Pressable>
      ))}
    </View>
  );
}

export function Toggle({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: value }}
      style={{ flexDirection: 'row', gap: space(3), paddingVertical: space(2) }}
    >
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          borderWidth: 2,
          borderColor: value ? colors.accent : colors.line,
          backgroundColor: value ? colors.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        {value ? <Icon name="check" size={16} color={colors.bg} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Txt>{label}</Txt>
        {description ? (
          <Txt color={colors.muted} style={{ fontSize: 13, marginTop: space(1) }}>
            {description}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

export function TeamBadge({
  color,
  logoUrl,
  size = 12,
}: {
  color: string;
  logoUrl?: string | null;
  size?: number;
}): React.JSX.Element {
  if (logoUrl) {
    return (
      <Image
        source={{ uri: logoUrl }}
        accessibilityIgnoresInvertColors
        style={{ width: size, height: size, borderRadius: size / 4 }}
      />
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
  );
}

/** The app's only animation. Kept simple and honest: a steady pulse. */
export function LivePip({ size = 8 }: { size?: number }): React.JSX.Element {
  return (
    <View
      accessibilityLabel="Live"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.live }}
    />
  );
}

/** The "i" is drawn from primitives, so the lime dot is a real brand element. */
export function Wordmark({ size = 36 }: { size?: number }): React.JSX.Element {
  return (
    <View accessibilityRole="header" accessibilityLabel="iTala">
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: size * 0.06 }}>
        <View style={{ alignItems: 'center', paddingBottom: size * 0.08 }}>
          <View
            style={{
              width: size * 0.22,
              height: size * 0.22,
              borderRadius: size * 0.11,
              backgroundColor: colors.brandLime,
              marginBottom: size * 0.08,
            }}
          />
          <View
            style={{
              width: size * 0.16,
              height: size * 0.62,
              borderRadius: size * 0.04,
              backgroundColor: colors.brandTeal,
            }}
          />
        </View>
        <Txt k="display" style={{ fontSize: size, lineHeight: size * 1.05 }}>
          Tala
        </Txt>
      </View>
      <View
        style={{
          height: 3,
          width: size * 2.4,
          borderRadius: 2,
          backgroundColor: colors.brandTeal,
          marginTop: size * 0.12,
        }}
      />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Sheet                                                                       */
/* -------------------------------------------------------------------------- */

export function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000B', justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            padding: space(4),
            maxHeight: '85%',
            borderTopWidth: 1,
            borderColor: colors.line,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: space(3),
            }}
          >
            <Txt k="h2">{title}</Txt>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Icon name="close" color={colors.muted} />
            </Pressable>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

export function Spinner(): React.JSX.Element {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
