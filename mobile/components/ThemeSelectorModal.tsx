import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../contexts/ThemeContext';
import { AnimatedPressable } from './AnimatedPressable';
import { ColorPalette } from '../constants/ColorPalettes';

interface ThemeSelectorModalProps {
  visible: boolean;
  onClose: () => void;
}

export function ThemeSelectorModal({ visible, onClose }: ThemeSelectorModalProps) {
  const { palette, paletteId, setPalette, palettes } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.container,
          {
            backgroundColor: palette.colors.background,
            paddingTop: insets.top + 16,
            paddingBottom: insets.bottom + 16,
          },
        ]}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <Text style={[styles.title, { color: palette.colors.textDark }]}>Color Theme</Text>
            <Text style={[styles.subtitle, { color: palette.colors.textMuted }]}>
              Pick a palette that matches the mood
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={palette.colors.textDark} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {palettes.map((p) => (
            <PaletteRow
              key={p.id}
              paletteOption={p}
              selected={p.id === paletteId}
              activePalette={palette}
              onSelect={() => {
                setPalette(p.id);
                onClose();
              }}
            />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

interface PaletteRowProps {
  paletteOption: ColorPalette;
  selected: boolean;
  activePalette: ColorPalette;
  onSelect: () => void;
}

function PaletteRow({ paletteOption, selected, activePalette, onSelect }: PaletteRowProps) {
  const previewColors = [
    paletteOption.colors.primary,
    paletteOption.colors.secondary,
    paletteOption.colors.accent,
    paletteOption.colors.background,
    paletteOption.colors.cardBg,
  ];

  return (
    <AnimatedPressable
      onPress={onSelect}
      style={[
        styles.row,
        {
          backgroundColor: activePalette.colors.cardBg,
          borderColor: selected
            ? activePalette.colors.accent
            : `${activePalette.colors.textMuted}22`,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      <View style={styles.rowTop}>
        <View style={styles.rowText}>
          <Text style={[styles.paletteName, { color: activePalette.colors.textDark }]}>
            {paletteOption.name}
          </Text>
          <Text style={[styles.paletteMood, { color: activePalette.colors.textMuted }]}>
            {paletteOption.mood}
          </Text>
        </View>
        {selected && (
          <View style={[styles.checkCircle, { backgroundColor: activePalette.colors.accent }]}>
            <Ionicons name="checkmark" size={16} color="#FFFFFF" />
          </View>
        )}
      </View>

      <Text style={[styles.paletteDesc, { color: activePalette.colors.textMuted }]}>
        {paletteOption.description}
      </Text>

      <View style={styles.swatchRow}>
        {previewColors.map((c, i) => (
          <View key={i} style={[styles.swatch, { backgroundColor: c }]} />
        ))}
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerLeft: {
    flex: 1,
  },
  title: {
    fontFamily: 'Baloo2_700Bold',
    fontSize: 24,
  },
  subtitle: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 13,
    marginTop: 2,
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: {
    gap: 12,
    paddingBottom: 24,
  },
  row: {
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowText: {
    flex: 1,
  },
  paletteName: {
    fontFamily: 'Nunito_700Bold',
    fontSize: 16,
  },
  paletteMood: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 12,
    marginTop: 2,
  },
  paletteDesc: {
    fontFamily: 'Quicksand_500Medium',
    fontSize: 13,
  },
  swatchRow: {
    flexDirection: 'row',
    height: 26,
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 4,
  },
  swatch: {
    flex: 1,
  },
  checkCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
