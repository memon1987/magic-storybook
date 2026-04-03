import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../hooks/useAuth';
import { Colors } from '../../constants/Colors';

export default function SettingsScreen() {
  const { user, logout } = useAuth();

  const handleLogout = () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
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
      ]
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Ionicons name="person-circle" size={24} color={Colors.light.accent} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Email</Text>
              <Text style={styles.rowValue}>{user?.email || 'Not signed in'}</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Ionicons name="information-circle" size={24} color={Colors.light.secondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Version</Text>
              <Text style={styles.rowValue}>1.0.0</Text>
            </View>
          </View>
        </View>
      </View>

      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Ionicons name="log-out" size={20} color={Colors.light.error} />
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.background,
    padding: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.light.textSecondary,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: Colors.light.card,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  rowContent: {
    flex: 1,
  },
  rowLabel: {
    fontSize: 14,
    fontFamily: 'Quicksand_400Regular',
    color: Colors.light.textSecondary,
  },
  rowValue: {
    fontSize: 16,
    fontFamily: 'Quicksand_500Medium',
    color: Colors.light.text,
    marginTop: 2,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.light.card,
    padding: 16,
    borderRadius: 12,
    marginTop: 'auto',
    gap: 8,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  logoutText: {
    fontSize: 16,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.light.error,
  },
});
