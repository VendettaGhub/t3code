# Keep T3 running in the Windows system tray

In Settings → General, enable **Desktop: keep running in system tray when closed** to hide the main window instead of exiting. Sessions and remote connections continue while the window is hidden. This preference is enabled by default and changes take effect on the next close, without restarting.

Click the T3 tray icon or choose **Open T3** to restore the window. Minimizing still uses the taskbar. Choose **Quit T3** in the tray menu to shut down the application and its managed backends completely. Disabling the preference restores normal window-close behavior. Updates and Windows shutdown are not intercepted.

This feature applies only to Windows desktop. It does not change web, mobile or macOS window behavior. If Windows cannot create the tray icon, closing remains normal so the window cannot become inaccessible.
