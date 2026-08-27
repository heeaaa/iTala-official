const noop = async () => ({});
module.exports = {
  setNotificationHandler: () => {}, requestPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  getPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
  scheduleNotificationAsync: noop, cancelAllScheduledNotificationsAsync: noop,
  cancelScheduledNotificationAsync: noop, getAllScheduledNotificationsAsync: async () => [],
  addNotificationReceivedListener: () => ({ remove: () => {} }),
  addNotificationResponseReceivedListener: () => ({ remove: () => {} }),
  setNotificationChannelAsync: noop, getExpoPushTokenAsync: async () => ({ data: 'stub' }),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 }, SchedulableTriggerInputTypes: { DATE: 'date' },
  __esModule: true,
};
