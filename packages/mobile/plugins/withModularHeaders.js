/**
 * Expo config plugin for CocoaPods settings not covered by the generated Podfile.
 *
 * WHY: the Firebase iOS SDK 11 (pulled in by `@react-native-firebase/messaging`
 * for the iOS FCM-token fix) ships `FirebaseCoreInternal` as a **Swift** pod that
 * depends on `GoogleUtilities`, an **Objective-C** pod that does NOT define module
 * maps. A Swift pod can only import an ObjC dependency when that dependency exposes
 * a module — so `pod install` fails with:
 *   "[!] The following Swift pods cannot yet be integrated as static libraries: The
 *    Swift pod `FirebaseCoreInternal` depends upon `GoogleUtilities`, which does not
 *    define modules … set `use_modular_headers!` globally."
 * This happens under DEFAULT static linkage too (NOT only `use_frameworks!`), which
 * is exactly why we do NOT enable `use_frameworks` (it conflicts with the New-Arch
 * C++ pods — react-native-mmkv/NitroModules, reanimated/worklets). The minimal,
 * New-Arch-friendly fix the CocoaPods error itself recommends is global modular
 * headers, which makes GoogleUtilities (and the other ObjC Google pods) generate
 * module maps so the Swift Firebase pods can import them as static libraries.
 *
 * `expo-build-properties` only exposes `modular_headers` PER-POD inside `extraPods`
 * (not a global `use_modular_headers!`), so this config plugin adds the global
 * directive. It is idempotent and re-applies on every prebuild.
 */
const { CodeGenerator, withPodfile, withPodfileProperties } = require('expo/config-plugins');

const DIRECTIVE = 'use_modular_headers!';
const IOS_DEPLOYMENT_TARGET = '16.4';
const DEPLOYMENT_TARGET_TAG = 'portable-xcode-27-resource-bundle-targets';

const RESOURCE_BUNDLE_DEPLOYMENT_TARGET = [
  `    minimum_ios_deployment_target = Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '${IOS_DEPLOYMENT_TARGET}')`,
  '    installer.pods_project.targets.each do |pod_target|',
  "      next unless pod_target.respond_to?(:product_type) && pod_target.product_type == 'com.apple.product-type.bundle'",
  '      pod_target.build_configurations.each do |build_configuration|',
  "        current_target = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']",
  '        next if current_target && Gem::Version.new(current_target) >= minimum_ios_deployment_target',
  "        build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum_ios_deployment_target.to_s",
  '      end',
  '    end',
].join('\n');

function patchPodfile(contents) {
  if (!contents.includes(DIRECTIVE)) {
    contents = contents.replace(/^(platform :ios.*$)/m, `$1\n${DIRECTIVE}`);
  }

  return CodeGenerator.mergeContents({
    tag: DEPLOYMENT_TARGET_TAG,
    src: contents,
    newSrc: RESOURCE_BUNDLE_DEPLOYMENT_TARGET,
    anchor: /^\s*post_install do \|installer\|/m,
    offset: 1,
    comment: '#',
  }).contents;
}

module.exports = function withModularHeaders(config) {
  config = withPodfileProperties(config, (cfg) => {
    cfg.modResults['ios.deploymentTarget'] = IOS_DEPLOYMENT_TARGET;
    return cfg;
  });

  return withPodfile(config, (cfg) => {
    cfg.modResults.contents = patchPodfile(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.patchPodfile = patchPodfile;
