/**
 * config.js — single place for front-end constants.
 * Everything else reads from PH.config, so there are no magic strings scattered around.
 */
(function () {
  window.PH = window.PH || {};

  PH.config = {
    API_BASE: '/api/v1',
    APP_VERSION: '1.0.0',
    CURRENCY: 'TZS',
    LOCALE: 'en-TZ',

    SESSION_KEY: 'ph.session',
    SESSION_TTL_MS: 12 * 60 * 60 * 1000,

    SYNC_INTERVAL_MS: 20000,
    MAX_SYNC_ATTEMPTS: 8,

    PROFESSIONS: ['Superintendent', 'Dispenser', 'Manager', 'Storekeeper', 'Accountant', 'Administrator'],

    /** Page number -> file + label. Page 1 is the login screen (not in the nav). */
    PAGES: {
      1: { file: 'index.html', title: 'Sign in', icon: 'lock', nav: false },
      2: { file: 'home.html', title: 'Home', icon: 'home', nav: true },
      3: { file: 'sales.html', title: 'Sales', icon: 'cart', nav: true },
      4: { file: 'assistant.html', title: 'Assistant', icon: 'info', nav: true },
      5: { file: 'inventory.html', title: 'Inventory', icon: 'box', nav: true },
      6: { file: 'alerts.html', title: 'Alerts', icon: 'bell', nav: true },
      7: { file: 'reports.html', title: 'Reports', icon: 'chart', nav: true },
      8: { file: 'settings.html', title: 'Settings', icon: 'settings', nav: true },
      9: { file: 'users.html', title: 'User Control', icon: 'users', nav: false },
      10: { file: 'sales-management.html', title: 'Sales Mgmt', icon: 'list', nav: true }
    },

    ALL_ACTIONS: [
      'assistant.search',
      'sales.create', 'sales.edit', 'sales.confirm',
      'inventory.restock', 'inventory.add', 'inventory.remove', 'inventory.edit',
      'alerts.view', 'reports.view', 'settings.manage', 'users.manage'
    ],

    ACTION_LABELS: {
      'assistant.search': 'Search assistant',
      'sales.create': 'Make a sale',
      'sales.edit': 'Edit a sale',
      'sales.confirm': 'Confirm a sale',
      'inventory.restock': 'Update stock (restock)',
      'inventory.add': 'Add item',
      'inventory.remove': 'Remove item',
      'inventory.edit': 'Edit item',
      'alerts.view': 'View alerts',
      'reports.view': 'View reports',
      'settings.manage': 'Manage settings',
      'users.manage': 'Manage users'
    }
  };
})();
