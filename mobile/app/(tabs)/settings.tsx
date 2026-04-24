import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../hooks/useAuth';
import { useTheme } from '../../contexts/ThemeContext';
import { GradientBackground } from '../../components/GradientBackground';
import { SectionCard } from '../../components/SectionCard';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { ThemeSelectorModal } from '../../components/ThemeSelectorModal';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

interface RowConfig {
  icon: IconName;
  label: string;
  value?: string;
  onPress?: () => void;
  disabled?: boolean;
}

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [themeModalOpen, setThemeModalOpen] = useState(false);

  const handleLogout = () =>
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          try {
            await logout();
          } catch {
            Alert.alert('Error', 'Failed to sign out');
          }
        },
      },
    ]);

  const personalization: RowConfig[] = [
    {
      icon: 'color-palette-outline',
      label: 'Color Theme',
      value: palette.name,
      onPress: () => setThemeModalOpen(true),
    },
    {
      icon: 'volume-medium-outline',
      label: 'Sound Effects',
      value: 'On',
      disabled: true,
    },
  ];

  const account: RowConfig[] = [
    { icon: 'mail-outline', label: 'Email', value: user?.email ?? 'Not signed in' },
    { icon: 'lock-closed-outline', label: 'Change Password', disabled: true },
  ];

  const support: RowConfig[] = [
    { icon: 'help-circle-outline', label: 'Help & FAQ', disabled: true },
    { icon: 'mail-outline', label: 'Contact Us', disabled: true },
    { icon: 'information-circle-outline', label: 'Version', value: '1.0.0' },
  ];

  return (
    <GradientBackground colors={[palette.colors.background, palette.colors.cardBg]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.title, { color: palette.colors.textDark }]}>Settings</Text>

        <SectionCard style={styles.profileCard}>
          <View style={[styles.avatar, { backgroundColor: palette.colors.primary }]}>
            <Ionicons name="person" size={28} color={palette.colors.textDark} />
          </View>
          <View style={styles.profileText}>
            <Text style={[styles.profileName, { color: palette.colors.textDark }]} numberOfLines={1}>
              {user?.email?.split('@')[0] ?? 'Storyteller'}
            </Text>
            <Text style={[styles.profileEmail, { color: palette.colors.textMuted }]} numberOfLines={1}>
              {user?.email ?? 'Not signed in'}
            </Text>
          </View>
        </SectionCard>

        <Section
          title="Personalization"
          rows={personalization}
          palette={palette.colors}
        />
        <Section title="Account" rows={account} palette={palette.colors} />
        <Section title="Support" rows={support} palette={palette.colors} />

        <AnimatedPressable
          onPress={handleLogout}
          style={[
            styles.logoutButton,
            {
              backgroundColor: palette.colors.cardBg,
              borderColor: `${palette.colors.accent}55`,
            },
          ]}
        >
          <Ionicons name="log-out-outline" size={20} color={palette.colors.accent} />
          <Text style={[styles.logoutText, { color: palette.colors.accent }]}>Sign Out</Text>
        </AnimatedPressable>
      </ScrollView>

      <ThemeSelectorModal
        visible={themeModalOpen}
        onClose={() => setThemeModalOpen(false)}
      />
    </GradientBackground>
  );
}

interface SectionProps {
  title: string;
  rows: RowConfig[];
  palette: {
    textDark: string;
    textMuted: string;
    cardBg: string;
    background: string;
  };
}

function Section({ title, rows, palette }: SectionProps) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: palette.textMuted }]}>{title}</Text>
      <SectionCard style={styles.sectionCard}>
        {rows.map((row, i) => (
          <Row
            key={row.label}
            row={row}
            palette={palette}
            isLast={i === rows.length - 1}
          />
        ))}
      </SectionCard>
    </View>
  );
}

interface RowProps {
  row: RowConfig;
  palette: {
    textDark: string;
    textMuted: string;
    background: string;
  };
  isLast: boolean;
}

function Row({ row, palette, isLast }: RowProps) {
  const rowStyle = [
    styles.row,
    !isLast && {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: `${palette.textMuted}22`,
    },
  ];

  const content = (
    <>
      <View style={[styles.rowIcon, { backgroundColor: palette.background }]}>
        <Ionicons
          name={row.icon}
          size={18}
          color={row.disabled ? palette.textMuted : palette.textDark}
        />
      </View>
      <Text
        style={[
          styles.rowLabel,
          { color: row.disabled ? palette.textMuted : palette.textDark },
        ]}
      >
        {row.label}
      </Text>
      {row.value && (
        <Text style={[styles.rowValue, { color: palette.textMuted }]} numberOfLines={1}>
          {row.value}
        </Text>
      )}
      {row.onPress && (
        <Ionicons name="chevron-forward" size={18} color={palette.textMuted} />
      )}
    </>
  );

  if (row.onPress) {
    return (
      <Pressable onPress={row.onPress} disabled={row.disabled} style={rowStyle}>
        {content}
      </Pressable>
    );
  }
  return <View style={rowStyle}>{content}</View>;
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 20,
    gap: 16,
  },
  title: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 28,
    marginBottom: 8,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileText: {
    flex: 1,
  },
  profileName: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 17,
    textTransform: 'capitalize',
  },
  profileEmail: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 13,
    marginTop: 2,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginLeft: 4,
  },
  sectionCard: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: {
    flex: 1,
    fontFamily: 'Nunito_600SemiBold',
    fontSize: 14,
  },
  rowValue: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 13,
    maxWidth: 140,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 8,
  },
  logoutText: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 15,
  },
});
