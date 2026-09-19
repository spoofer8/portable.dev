import fs from 'node:fs';
import { createRequire } from 'node:module';

const podfilePlugin = require('../plugins/withModularHeaders');

const generatedPodfile = `platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'

prepare_react_native_project!

target 'Portable' do
  post_install do |installer|
    react_native_post_install(
      installer,
      config[:reactNativePath],
      :mac_catalyst_enabled => false,
    )
  end
end
`;

describe('iOS Podfile compatibility plugin', () => {
  it('adds modular headers and raises old resource bundles to iOS 16.4', () => {
    const patched = podfilePlugin.patchPodfile(generatedPodfile);

    expect(patched).toContain(
      "platform :ios, podfile_properties['ios.deploymentTarget'] || '16.4'\nuse_modular_headers!"
    );
    expect(patched).toContain(
      "pod_target.respond_to?(:product_type) && pod_target.product_type == 'com.apple.product-type.bundle'"
    );
    expect(patched).toContain('Gem::Version.new(current_target) >= minimum_ios_deployment_target');
    expect(patched).toContain(
      "build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum_ios_deployment_target.to_s"
    );
  });

  it('is idempotent', () => {
    const once = podfilePlugin.patchPodfile(generatedPodfile);
    const twice = podfilePlugin.patchPodfile(once);

    expect(twice).toBe(once);
    expect(twice.match(/@generated begin portable-xcode-27-resource-bundle-targets/g)).toHaveLength(
      1
    );
  });
});

describe('Xcode 27 dependency compatibility', () => {
  it('uses the Expo Modules JSI release with the Swift callback fix', () => {
    const expoPackagePath = require.resolve('expo/package.json');
    const expoRequire = createRequire(expoPackagePath);
    const corePackagePath = expoRequire.resolve('expo-modules-core/package.json');
    const coreRequire = createRequire(corePackagePath);
    const jsiPackagePath = coreRequire.resolve('expo-modules-jsi/package.json');
    const jsiPackage = JSON.parse(fs.readFileSync(jsiPackagePath, 'utf8'));

    expect(jsiPackage.version).toBe('56.0.13');
  });
});
