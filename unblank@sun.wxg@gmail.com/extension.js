// -*- mode: js2; indent-tabs-mode: nil; js2-basic-offset: 4 -*-

const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Mainloop = imports.mainloop;

const Gettext = imports.gettext.domain('gnome-shell-extensions');
const _ = Gettext.gettext;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Tweener = imports.ui.tweener;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

const ScreenShield = imports.ui.screenShield;

const SCHEMA_NAME = 'org.gnome.shell.extensions.unblank';
const MANUAL_FADE_TIME = 0.3;
const ARROW_IDLE_TIME = 30000; // ms

const UPowerIface = '<node> \
<interface name="org.freedesktop.UPower"> \
    <property name="OnBattery" type="b" access="read"/> \
</interface> \
</node>';

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerIface);

class Unblank {
    constructor() {
        this.gsettings = Convenience.getSettings(SCHEMA_NAME);

        this.setActiveOrigin = Main.screenShield._setActive;
        this.activateFadeOrigin = Main.screenShield._activateFade;
        this.resetLockScreenOrigin = Main.screenShield._resetLockScreen;
        this.startArrowAnimationOrigin = Main.ScreenShield._startArrowAnimation;
        this.pauseArrowAnimationOrigin = Main.ScreenShield._pauseArrowAnimation;
        this.stopArrowAnimationOrigin = Main.ScreenShield._stopArrowAnimation;
        this.liftShieldOrigin = Main.ScreenShield._liftShield;

        this.connect_signal();
        this._switchChanged();

        this.powerProxy = new UPowerProxy(Gio.DBus.system,
                                'org.freedesktop.UPower',
                                '/org/freedesktop/UPower',
                                (proxy, error) => {
                                    if (error) {
                                        log(error.message);
                                        return;
                                    }
                                    this.powerProxy.connect('g-properties-changed', () => this.sync());
                                    this.sync();
                                });
    }

    _switchChanged() {
        this.isUnblank = this.gsettings.get_boolean('switch');
        if (this.isUnblank) {
            Main.screenShield._setActive = _setActive;
            Main.screenShield._activateFade = _activateFade;
            Main.screenShield._resetLockScreen = _resetLockScreen;
            Main.screenShield._startArrowAnimation = _startArrowAnimation;
            Main.screenShield._pauseArrowAnimation = _pauseArrowAnimation;
            Main.screenShield._stopArrowAnimation = _stopArrowAnimation;
            Main.screenShield._liftShield = _liftShield;
        } else {
            Main.screenShield._setActive = this.setActiveOrigin;
            Main.screenShield._activateFade = this.activateFadeOrigin;
            Main.screenShield._resetLockScreen = this.resetLockScreenOrigin;
            Main.screenShield._startArrowAnimation = this.startArrowAnimationOrigin;
            Main.screenShield._pauseArrowAnimation = this.pauseArrowAnimationOrigin;
            Main.screenShield._stopArrowAnimation = this.stopArrowAnimationOrigin;
            Main.screenShield._liftShield = this.liftShieldOrigin;
        }
    }

    connect_signal() {
        this.signalSwitchId = this.gsettings.connect("changed::switch", this._switchChanged.bind(this));
    }

    sync() {
        //if (Main.screenShield._isActive && powerProxy.OnBattery) {
        //    Main.screenShield.emit('active-changed');
        //}
    }
}

const BLANK_DELAY = 6000 * 1; // min

function _setActive(active) {
    print("wxg: _setActive: active=", active);
    let prevIsActive = this._isActive;
    this._isActive = active;

    if (active && !this._pointerWatchId) {
        this._pointerWatchId = Mainloop.timeout_add(1000, _setPointerVisible.bind(this));
        GLib.Source.set_name_by_id(this._pointerWatchId, '[gnome-shell] this._setPointerVisible');
    }

    if (prevIsActive != this._isActive) {
        if (active) {
            if (this._blankDelayId) {
                Mainloop.source_remove(this._blankDelayId);
                this._blankDelayId= 0;
            }

            this._blankDelayId = Mainloop.timeout_add(BLANK_DELAY,
                                                      () => {
                                                          print("wxg: emit active-changes");
                                                          this.emit('active-changed');
                                                          this._blankDelayId = 0;
                                                          return GLib.SOURCE_REMOVE;
                                                      });
        } else
            this.emit('active-changed');

        if (!unblank.isUnblank) {
            this.emit('active-changed');
        }
    }

    if (this._loginSession)
        this._loginSession.SetLockedHintRemote(active);

    this._syncInhibitor();
}

function _activateFade(lightbox, time) {
    Main.uiGroup.set_child_above_sibling(lightbox.actor, null);
    if (unblank.isUnblank) {
        if (lightbox != this._longLightbox)
            lightbox.show(time);
    } else {
        lightbox.show(time);
    }

    if (this._becameActiveId == 0)
        this._becameActiveId = this.idleMonitor.add_user_active_watch(this._onUserBecameActive.bind(this))
}

function _resetLockScreen(params) {
    if (this._lockScreenState != MessageTray.State.HIDDEN)
        return;

    this._ensureLockScreen();
    this._lockDialogGroup.scale_x = 1;
    this._lockDialogGroup.scale_y = 1;

    this._lockScreenGroup.show();
    this._lockScreenState = MessageTray.State.SHOWING;

    let fadeToBlack;
    if (unblank.isUnblank) {
        fadeToBlack = false;
    } else {
        fadeToBlack = params.fadeToBlack;
    }

    if (params.animateLockScreen) {
        this._lockScreenGroup.y = -global.screen_height;
        Tweener.removeTweens(this._lockScreenGroup);
        Tweener.addTween(this._lockScreenGroup,
                         { y: 0,
                           time: MANUAL_FADE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: function() {
                               this._lockScreenShown({ fadeToBlack: fadeToBlack,
                                                       animateFade: true });
                           },
                           onCompleteScope: this
                         });
    } else {
        this._lockScreenGroup.fixed_position_set = false;
        this._lockScreenShown({ fadeToBlack: fadeToBlack,
                                animateFade: false });
    }

    this._lockScreenGroup.grab_key_focus();

    if (Main.sessionMode.currentMode != 'lock-screen')
        Main.sessionMode.pushMode('lock-screen');
}

function _liftShield(onPrimary, velocity) {
    if (this._isLocked) {
        if (this._ensureUnlockDialog(onPrimary, true /* allowCancel */)) {
            this._hideLockScreen(true /* animate */, velocity);
            if (this._pointerWatchId) {
                Mainloop.source_remove(this._pointerWatchId);
                this._pointerWatchId= 0;
            }
            if (this._blankDelayId) {
                Mainloop.source_remove(this._blankDelayId);
                this._blankDelayId= 0;
            }
        }
    } else {
        this.deactivate(true /* animate */);
    }
}

function _startArrowAnimation() {
    this._arrowActiveWatchId = 0;
    this._arrowAnimationState = 1;

    if (!this._arrowAnimationId) {
        this._arrowAnimationId = Mainloop.timeout_add(6000, this._animateArrows.bind(this));
        GLib.Source.set_name_by_id(this._arrowAnimationId, '[gnome-shell] this._animateArrows');
        this._animateArrows();
    }

    if (!this._arrowWatchId)
        this._arrowWatchId = this.idleMonitor.add_idle_watch(ARROW_IDLE_TIME,
            this._pauseArrowAnimation.bind(this));
}

function _setPointerVisible() {
    if (this._lockScreenState == MessageTray.State.SHOWN && this._arrowAnimationState == 0) {
        if (!this._motionId)
            this._motionId = global.stage.connect('captured-event', (stage, event) => {
                if (event.type() == Clutter.EventType.MOTION) {
                    this._cursorTracker.set_pointer_visible(true);
                    global.stage.disconnect(this._motionId);
                    this._motionId = 0;
                }

                return Clutter.EVENT_PROPAGATE;
            });

        this._cursorTracker.set_pointer_visible(false);
    }

    return GLib.SOURCE_CONTINUE;
}

function _pauseArrowAnimation() {
    this._arrowAnimationState = 0;

    if (this._arrowAnimationId) {
        Mainloop.source_remove(this._arrowAnimationId);
        this._arrowAnimationId = 0;
    }

    if (!this._arrowActiveWatchId)
        this._arrowActiveWatchId = this.idleMonitor.add_user_active_watch(this._startArrowAnimation.bind(this));
}

function _stopArrowAnimation() {
    this._arrowAnimationState = 0;

    if (this._arrowAnimationId) {
        Mainloop.source_remove(this._arrowAnimationId);
        this._arrowAnimationId = 0;
    }
    if (this._arrowActiveWatchId) {
        this.idleMonitor.remove_watch(this._arrowActiveWatchId);
        this._arrowActiveWatchId = 0;
    }
    if (this._arrowWatchId) {
        this.idleMonitor.remove_watch(this._arrowWatchId);
        this._arrowWatchId = 0;
    }
    if (this._pointerWatchId) {
        Mainloop.source_remove(this._pointerWatchId);
        this._pointerWatchId= 0;
    }
    if (this._blankDelayId) {
        Mainloop.source_remove(this._blankDelayId);
        this._blankDelayId= 0;
    }
}

let unblank;

function init() {
    unblank = new Unblank();
}

function enable() {
}

function disable() {
}
