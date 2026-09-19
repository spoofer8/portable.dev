const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const SCENE_CONFIGURATION_METHOD = [
  '  public func application(',
  '    _ application: UIApplication,',
  '    configurationForConnecting connectingSceneSession: UISceneSession,',
  '    options: UIScene.ConnectionOptions',
  '  ) -> UISceneConfiguration {',
  '    let configuration = UISceneConfiguration(',
  '      name: "Default Configuration",',
  '      sessionRole: connectingSceneSession.role',
  '    )',
  '    configuration.delegateClass = SceneDelegate.self',
  '    return configuration',
  '  }',
  '',
].join('\n');

const DID_FINISH_SIGNATURE = [
  '  public override func application(',
  '    _ application: UIApplication,',
  '    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil',
  '  ) -> Bool {',
  '',
].join('\n');

const SCENE_DELEGATE_CLASS = [
  'class SceneDelegate: UIResponder, UIWindowSceneDelegate {',
  '  var window: UIWindow?',
  '',
  '  func scene(',
  '    _ scene: UIScene,',
  '    willConnectTo session: UISceneSession,',
  '    options connectionOptions: UIScene.ConnectionOptions',
  '  ) {',
  '    guard let windowScene = scene as? UIWindowScene else {',
  '      return',
  '    }',
  '    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,',
  '      let factory = appDelegate.reactNativeFactory else {',
  '      fatalError("SceneDelegate could not find the React Native factory")',
  '    }',
  '',
  '    let nextWindow = UIWindow(windowScene: windowScene)',
  '    window = nextWindow',
  '    appDelegate.window = nextWindow',
  '    let browsingWebActivity = connectionOptions.userActivities.first {',
  '      $0.activityType == NSUserActivityTypeBrowsingWeb',
  '    }',
  '    factory.startReactNative(',
  '      withModuleName: "main",',
  '      in: nextWindow,',
  '      launchOptions: Self.launchOptions(',
  '        base: appDelegate.launchOptions,',
  '        url: connectionOptions.urlContexts.first?.url,',
  '        userActivity: browsingWebActivity',
  '      )',
  '    )',
  '',
  '    for urlContext in connectionOptions.urlContexts {',
  '      self.scene(scene, openURLContexts: [urlContext])',
  '    }',
  '    for userActivity in connectionOptions.userActivities {',
  '      self.scene(scene, continue: userActivity)',
  '    }',
  '    if let shortcutItem = connectionOptions.shortcutItem {',
  '      appDelegate.application(',
  '        UIApplication.shared,',
  '        performActionFor: shortcutItem,',
  '        completionHandler: { _ in }',
  '      )',
  '    }',
  '  }',
  '',
  '  func sceneDidDisconnect(_ scene: UIScene) {',
  '    window = nil',
  '  }',
  '',
  '  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {',
  '    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {',
  '      return',
  '    }',
  '    for urlContext in URLContexts {',
  '      var options: [UIApplication.OpenURLOptionsKey: Any] = [',
  '        .openInPlace: urlContext.options.openInPlace',
  '      ]',
  '      if let sourceApplication = urlContext.options.sourceApplication {',
  '        options[.sourceApplication] = sourceApplication',
  '      }',
  '      if let annotation = urlContext.options.annotation {',
  '        options[.annotation] = annotation',
  '      }',
  '      _ = appDelegate.application(',
  '        UIApplication.shared,',
  '        open: urlContext.url,',
  '        options: options',
  '      )',
  '    }',
  '  }',
  '',
  '  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {',
  '    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {',
  '      return',
  '    }',
  '    _ = appDelegate.application(',
  '      UIApplication.shared,',
  '      continue: userActivity,',
  '      restorationHandler: { _ in }',
  '    )',
  '  }',
  '',
  '  func scene(_ scene: UIScene, willContinueUserActivityWithType userActivityType: String) {',
  '    _ = (UIApplication.shared.delegate as? AppDelegate)?.application(',
  '      UIApplication.shared,',
  '      willContinueUserActivityWithType: userActivityType',
  '    )',
  '  }',
  '',
  '  func scene(',
  '    _ scene: UIScene,',
  '    didFailToContinueUserActivityWithType userActivityType: String,',
  '    error: Error',
  '  ) {',
  '    (UIApplication.shared.delegate as? AppDelegate)?.application(',
  '      UIApplication.shared,',
  '      didFailToContinueUserActivityWithType: userActivityType,',
  '      error: error',
  '    )',
  '  }',
  '',
  '  func scene(_ scene: UIScene, didUpdate userActivity: NSUserActivity) {',
  '    (UIApplication.shared.delegate as? AppDelegate)?.application(',
  '      UIApplication.shared,',
  '      didUpdate: userActivity',
  '    )',
  '  }',
  '',
  '  func windowScene(',
  '    _ windowScene: UIWindowScene,',
  '    performActionFor shortcutItem: UIApplicationShortcutItem,',
  '    completionHandler: @escaping (Bool) -> Void',
  '  ) {',
  '    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {',
  '      completionHandler(false)',
  '      return',
  '    }',
  '    appDelegate.application(',
  '      UIApplication.shared,',
  '      performActionFor: shortcutItem,',
  '      completionHandler: completionHandler',
  '    )',
  '  }',
  '',
  '  func sceneDidBecomeActive(_ scene: UIScene) {',
  '    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidBecomeActive(',
  '      UIApplication.shared',
  '    )',
  '  }',
  '',
  '  func sceneWillResignActive(_ scene: UIScene) {',
  '    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillResignActive(',
  '      UIApplication.shared',
  '    )',
  '  }',
  '',
  '  func sceneWillEnterForeground(_ scene: UIScene) {',
  '    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillEnterForeground(',
  '      UIApplication.shared',
  '    )',
  '  }',
  '',
  '  func sceneDidEnterBackground(_ scene: UIScene) {',
  '    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidEnterBackground(',
  '      UIApplication.shared',
  '    )',
  '  }',
  '',
  '  private static func launchOptions(',
  '    base: [UIApplication.LaunchOptionsKey: Any]?,',
  '    url: URL?,',
  '    userActivity: NSUserActivity?',
  '  ) -> [UIApplication.LaunchOptionsKey: Any]? {',
  '    var launchOptions = base ?? [:]',
  '    if let url {',
  '      let urlKey = UIApplication.LaunchOptionsKey(',
  '        rawValue: "UIApplicationLaunchOptionsURLKey"',
  '      )',
  '      launchOptions[urlKey] = url',
  '    }',
  '    if let userActivity {',
  '      let activityKey = UIApplication.LaunchOptionsKey(',
  '        rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey"',
  '      )',
  '      launchOptions[activityKey] = [',
  '        "UIApplicationLaunchOptionsUserActivityTypeKey": userActivity.activityType,',
  '        "UIApplicationLaunchOptionsUserActivityKey": userActivity',
  '      ]',
  '    }',
  '    return launchOptions.isEmpty ? nil : launchOptions',
  '  }',
  '}',
  '',
].join('\n');

function patchAppDelegate(contents) {
  contents = contents.replace(
    '  public override func application(\n    _ application: UIApplication,\n    configurationForConnecting connectingSceneSession: UISceneSession,',
    '  public func application(\n    _ application: UIApplication,\n    configurationForConnecting connectingSceneSession: UISceneSession,'
  );

  const sceneClassMarker = 'class SceneDelegate: UIResponder, UIWindowSceneDelegate';
  const delegateMarker = 'class ReactNativeDelegate: ExpoReactNativeFactoryDelegate';
  const factoryProperty = '  var reactNativeFactory: RCTReactNativeFactory?\n';
  const legacyWindow = '    window = UIWindow(frame: UIScreen.main.bounds)\n';
  const legacyStart = [
    '    factory.startReactNative(',
    '      withModuleName: "main",',
    '      in: window,',
    '      launchOptions: launchOptions)',
    '',
  ].join('\n');
  const linkingMarker = '  // Linking API\n';
  const appDelegateSceneMarkers = [
    'var launchOptions: [UIApplication.LaunchOptionsKey: Any]?',
    'self.launchOptions = launchOptions',
    'configurationForConnecting connectingSceneSession',
  ];

  if (contents.includes(sceneClassMarker)) {
    const missingMarker = appDelegateSceneMarkers.find((marker) => !contents.includes(marker));
    const sceneStart = contents.indexOf(sceneClassMarker);
    const sceneEnd = contents.indexOf(delegateMarker, sceneStart);
    if (
      missingMarker ||
      sceneEnd === -1 ||
      contents.includes(legacyWindow) ||
      contents.includes(legacyStart)
    ) {
      throw new Error('withIosSceneLifecycle found an incomplete scene lifecycle patch');
    }
    return `${contents.slice(0, sceneStart)}${SCENE_DELEGATE_CLASS}${contents.slice(sceneEnd)}`;
  }

  if (appDelegateSceneMarkers.some((marker) => contents.includes(marker))) {
    throw new Error('withIosSceneLifecycle found an incomplete scene lifecycle patch');
  }

  for (const marker of [
    factoryProperty,
    DID_FINISH_SIGNATURE,
    legacyWindow,
    legacyStart,
    linkingMarker,
    delegateMarker,
  ]) {
    if (!contents.includes(marker)) {
      throw new Error(`withIosSceneLifecycle could not find: ${marker.trim()}`);
    }
  }

  return contents
    .replace(
      factoryProperty,
      `${factoryProperty}  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n`
    )
    .replace(
      DID_FINISH_SIGNATURE,
      `${DID_FINISH_SIGNATURE}    self.launchOptions = launchOptions\n`
    )
    .replace(legacyWindow, '')
    .replace(legacyStart, '')
    .replace(linkingMarker, `${SCENE_CONFIGURATION_METHOD}${linkingMarker}`)
    .replace(delegateMarker, `${SCENE_DELEGATE_CLASS}${delegateMarker}`);
}

function withSceneManifest(infoPlist) {
  const existingManifest = infoPlist.UIApplicationSceneManifest || {};
  const existingConfigurations = existingManifest.UISceneConfigurations || {};
  const appConfiguration = [
    {
      UISceneConfigurationName: 'Default Configuration',
      UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
    },
  ];
  const existingAppConfiguration = existingConfigurations.UIWindowSceneSessionRoleApplication;

  if (
    existingManifest.UIApplicationSupportsMultipleScenes === true ||
    (existingAppConfiguration &&
      JSON.stringify(existingAppConfiguration) !== JSON.stringify(appConfiguration))
  ) {
    throw new Error('withIosSceneLifecycle found a conflicting scene manifest');
  }

  return {
    ...infoPlist,
    UIApplicationSceneManifest: {
      ...existingManifest,
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        ...existingConfigurations,
        UIWindowSceneSessionRoleApplication: appConfiguration,
      },
    },
  };
}

module.exports = function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = withSceneManifest(cfg.modResults);
    return cfg;
  });

  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('withIosSceneLifecycle requires a Swift AppDelegate');
    }
    cfg.modResults.contents = patchAppDelegate(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.patchAppDelegate = patchAppDelegate;
module.exports.withSceneManifest = withSceneManifest;
