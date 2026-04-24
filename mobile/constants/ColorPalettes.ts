export interface PaletteColors {
  primary: string;
  primaryHover: string;
  secondary: string;
  secondaryHover: string;
  accent: string;
  accentHover: string;
  background: string;
  cardBg: string;
  textDark: string;
  textMuted: string;
}

export interface ColorPalette {
  id: string;
  name: string;
  description: string;
  mood: string;
  colors: PaletteColors;
}

export const colorPalettes: ColorPalette[] = [
  {
    id: 'magical',
    name: 'Magical Dreams',
    description: 'Soft yellow, lavender, and coral for cozy bedtime stories.',
    mood: 'Whimsical & dreamy',
    colors: {
      primary: '#FFD93D',
      primaryHover: '#FFE775',
      secondary: '#C9B1FF',
      secondaryHover: '#D4C3FF',
      accent: '#FF6B6B',
      accentHover: '#FF8585',
      background: '#FFF9E8',
      cardBg: '#FFFFFF',
      textDark: '#2D2D2D',
      textMuted: '#4A4A4A',
    },
  },
  {
    id: 'rainbow',
    name: 'Rainbow Adventure',
    description: 'Pink, teal, and yellow for big, bold adventures.',
    mood: 'Playful & energetic',
    colors: {
      primary: '#FF6B9D',
      primaryHover: '#FF85AD',
      secondary: '#4ECDC4',
      secondaryHover: '#6ED7CF',
      accent: '#FFD93D',
      accentHover: '#FFE775',
      background: '#FFF5F7',
      cardBg: '#FFFFFF',
      textDark: '#2D3142',
      textMuted: '#5E6472',
    },
  },
  {
    id: 'forest',
    name: 'Forest Friends',
    description: 'Greens and soft blue for woodland tales.',
    mood: 'Earthy & calm',
    colors: {
      primary: '#7ED957',
      primaryHover: '#95E372',
      secondary: '#87CEEB',
      secondaryHover: '#A0D8F0',
      accent: '#FFB84D',
      accentHover: '#FFC670',
      background: '#F5FFF0',
      cardBg: '#FFFFFF',
      textDark: '#2D5016',
      textMuted: '#5A6C52',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean Waves',
    description: 'Cyan, pink, and yellow for underwater journeys.',
    mood: 'Cool & refreshing',
    colors: {
      primary: '#00D9FF',
      primaryHover: '#33E1FF',
      secondary: '#FF6F91',
      secondaryHover: '#FF89A5',
      accent: '#FFE66D',
      accentHover: '#FFED8E',
      background: '#F0FBFF',
      cardBg: '#FFFFFF',
      textDark: '#0A3D5C',
      textMuted: '#4A7C9C',
    },
  },
  {
    id: 'candy',
    name: 'Candy Shop',
    description: 'Pastel pinks, blues, and creams for the sweetest stories.',
    mood: 'Sweet & gentle',
    colors: {
      primary: '#FFB3D9',
      primaryHover: '#FFC7E3',
      secondary: '#B4E7FF',
      secondaryHover: '#C8EEFF',
      accent: '#FFE4B5',
      accentHover: '#FFEDC7',
      background: '#FFFEF9',
      cardBg: '#FFFFFF',
      textDark: '#4A3F35',
      textMuted: '#8B7E74',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset Stories',
    description: 'Coral, purple, and gold for warm evening reads.',
    mood: 'Warm & nostalgic',
    colors: {
      primary: '#FF9A76',
      primaryHover: '#FFAD90',
      secondary: '#C77DFF',
      secondaryHover: '#D399FF',
      accent: '#FFD97D',
      accentHover: '#FFE399',
      background: '#FFF5F0',
      cardBg: '#FFFFFF',
      textDark: '#3D2E2E',
      textMuted: '#6B5656',
    },
  },
];

export const defaultPaletteId = 'magical';
