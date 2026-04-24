import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colorPalettes, defaultPaletteId, ColorPalette } from '../constants/ColorPalettes';

const STORAGE_KEY = '@storybook/palette_id';

interface ThemeContextValue {
  palette: ColorPalette;
  paletteId: string;
  setPalette: (id: string) => void;
  palettes: ColorPalette[];
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [paletteId, setPaletteId] = useState<string>(defaultPaletteId);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved && colorPalettes.some((p) => p.id === saved)) {
        setPaletteId(saved);
      }
    });
  }, []);

  const setPalette = useCallback((id: string) => {
    if (!colorPalettes.some((p) => p.id === id)) return;
    setPaletteId(id);
    AsyncStorage.setItem(STORAGE_KEY, id).catch(() => {});
  }, []);

  const palette = colorPalettes.find((p) => p.id === paletteId) ?? colorPalettes[0];

  return (
    <ThemeContext.Provider value={{ palette, paletteId, setPalette, palettes: colorPalettes }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
