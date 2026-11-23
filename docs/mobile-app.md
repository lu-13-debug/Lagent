# 手机端

Lagent 的手机端由两部分组成：

- **移动页面** `/m`：仓库里已有的响应式指挥台（`src/mobile/MobileApp.tsx`），负责配对、看任务、审批、下达指令。它是 PWA，浏览器里可以直接「添加到主屏幕」。
- **Android 外壳** `mobile/android/`：一个极简 WebView App，只加载 `https://lagent.site/m`，负责全屏显示、返回键、外链跳系统和断网重试。业务逻辑仍然只有 `/m` 这一份。

## 安装到手机

1. 把 `mobile/android/app/build/outputs/apk/release/app-release.apk` 传到手机（数据线、微信文件传输、网盘都行），点开安装。首次需要在系统里允许「安装未知来源应用」。
2. 打开 Lagent，进入「连接你的指挥台」。
3. 在电脑浏览器登录 `https://lagent.site`，在指挥台页面找到「手机指挥」，点「生成配对码」。
4. 把六位配对码填进手机 App，点「连接」。

配对码 5 分钟有效、只能用一次；配对成功后设备凭证 90 天过期，过期需要重新配对。

## 构建

需要 JDK 17 或更高、Android SDK（platform 34 + build-tools 34.0.0）、Gradle 8.9。

```bash
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
<gradle 目录>/bin/gradle -p mobile/android assembleRelease
```

产物在 `mobile/android/app/build/outputs/apk/release/app-release.apk`。

签名信息放在 `mobile/android/keystore.properties`（已在 `.gitignore` 里），格式：

```properties
storeFile=D:/android-build/lagent-release.jks
storePassword=****
keyAlias=lagent
keyPassword=****
```

没有这个文件时 `assembleRelease` 会产出未签名的包，装不上；`assembleDebug` 可以用调试签名先验证功能。

**这个 keystore 必须长期保存**：Android 只允许用同一个签名覆盖安装，丢了就只能让用户卸载重装、数据全丢。不要把 `.jks` 和 `keystore.properties` 提交进仓库或发到群里。

## 修改服务地址

默认写死在 `mobile/android/app/src/main/java/site/lagent/mobile/MainActivity.java` 的 `HOME_URL`。换域名时改这一处，同时把 `SITE_HOST` 改成新域名的根域（用于判断哪些链接留在 App 内打开）。

## 版本号

改 `mobile/android/app/build.gradle` 里的 `versionCode` 和 `versionName`。`versionCode` 必须是递增整数，否则新包装不上。
