const scenePlugin = require('../plugins/withIosSceneLifecycle');

const generatedAppDelegate = `internal import Expo
import FirebaseCore
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
FirebaseApp.configure()
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
}
`;

describe('iOS scene lifecycle plugin', () => {
  it('moves React Native window startup into a scene delegate', () => {
    const patched = scenePlugin.patchAppDelegate(generatedAppDelegate);

    expect(patched).toContain('var launchOptions: [UIApplication.LaunchOptionsKey: Any]?');
    expect(patched).toContain('configurationForConnecting connectingSceneSession');
    expect(patched).not.toContain(
      'public override func application(\n    _ application: UIApplication,\n    configurationForConnecting'
    );
    expect(patched).toContain('class SceneDelegate: UIResponder, UIWindowSceneDelegate');
    expect(patched).toContain('let nextWindow = UIWindow(windowScene: windowScene)');
    expect(patched).toContain('url: connectionOptions.urlContexts.first?.url');
    expect(patched).toContain('UIApplicationLaunchOptionsUserActivityDictionaryKey');
    expect(patched).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
    expect(patched.match(/FirebaseApp\.configure\(\)/g)).toHaveLength(1);
  });

  it('is idempotent', () => {
    const once = scenePlugin.patchAppDelegate(generatedAppDelegate);
    expect(scenePlugin.patchAppDelegate(once)).toBe(once);
  });

  it('rejects an incomplete scene migration', () => {
    const partial = generatedAppDelegate.replace(
      'class ReactNativeDelegate',
      'class SceneDelegate: UIResponder, UIWindowSceneDelegate {}\n\nclass ReactNativeDelegate'
    );

    expect(() => scenePlugin.patchAppDelegate(partial)).toThrow('incomplete scene lifecycle patch');
  });

  it('rejects a scene migration that still starts the legacy window', () => {
    const patched = scenePlugin.patchAppDelegate(generatedAppDelegate);
    const duplicated = patched.replace(
      '#if os(iOS) || os(tvOS)',
      '#if os(iOS) || os(tvOS)\n    window = UIWindow(frame: UIScreen.main.bounds)'
    );

    expect(() => scenePlugin.patchAppDelegate(duplicated)).toThrow(
      'incomplete scene lifecycle patch'
    );
  });

  it('declares a single default scene configuration without discarding other roles', () => {
    expect(
      scenePlugin.withSceneManifest({
        UIApplicationSceneManifest: {
          ExistingSceneSetting: true,
          UISceneConfigurations: {
            ExistingRole: [{ UISceneConfigurationName: 'Existing' }],
          },
        },
      })
    ).toEqual({
      UIApplicationSceneManifest: {
        ExistingSceneSetting: true,
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          ExistingRole: [{ UISceneConfigurationName: 'Existing' }],
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: 'Default Configuration',
              UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
            },
          ],
        },
      },
    });
  });

  it('rejects a conflicting application scene configuration', () => {
    expect(() =>
      scenePlugin.withSceneManifest({
        UIApplicationSceneManifest: {
          UISceneConfigurations: {
            UIWindowSceneSessionRoleApplication: [
              { UISceneDelegateClassName: 'ExistingSceneDelegate' },
            ],
          },
        },
      })
    ).toThrow('conflicting scene manifest');
  });
});
