// GhosttyHostView.m — minimal NSView subclass that hosts ghostty's
// CAMetalLayer-backed renderer. Forwards AppKit input events into the
// libghostty C API.
//
// Reference implementation we mirror (in Swift):
//   vendor/ghostty/macos/Sources/Ghostty/Surface View/SurfaceView_AppKit.swift
//
// We intentionally start small. Things missing in v1:
//   - NSTextInputClient (IME / dead keys)
//   - Mouse pressure / scroll momentum tracking
//   - Magnify (pinch-zoom) gesture
//   - Trackpad swipe / dock-tile updates
// Add as we move through the milestones.

#import "GhosttyHostView.h"
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <stdatomic.h>
#import <dispatch/dispatch.h>

@interface GhosttyHostView : NSView <NSTextInputClient> {
    ghostty_surface_t          _surface;
    NSTrackingArea            *_tracking;
    NSMutableAttributedString *_markedText;
    NSRange                    _markedRange;
    NSRange                    _selectedRange;
    // Set to a non-nil array around `interpretKeyEvents:` so our
    // `insertText:` override can buffer committed text instead of
    // forwarding directly. keyDown then emits ONE structured key
    // event with the buffered text — preventing double-dispatch
    // (one from send_key_event's text field, one from insertText).
    NSMutableArray<NSString *> *_imeAccumulator;
}
- (ghostty_surface_t)surface; // Accessor for C-side helpers.
@end

@implementation GhosttyHostView

- (instancetype)initWithFrame:(NSRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    _surface = NULL;
    _markedText = [[NSMutableAttributedString alloc] init];
    _markedRange = NSMakeRange(NSNotFound, 0);
    _selectedRange = NSMakeRange(NSNotFound, 0);
    _imeAccumulator = nil;
    self.wantsLayer = YES;
    self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    // Accept file drag-and-drop. Dropped paths are sent to the
    // surface as text (ghostty_surface_text) — typed at the prompt
    // as if the user pasted them. Matches Terminal.app behaviour.
    [self registerForDraggedTypes:@[NSPasteboardTypeFileURL,
                                     NSPasteboardTypeString]];

    // Listen for app-level activation so we can keep ghostty's
    // focus state in sync. Without this, cursor blink doesn't
    // pause when the app is backgrounded.
    NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
    [nc addObserver:self
           selector:@selector(appDidBecomeActive:)
               name:NSApplicationDidBecomeActiveNotification
             object:nil];
    [nc addObserver:self
           selector:@selector(appDidResignActive:)
               name:NSApplicationDidResignActiveNotification
             object:nil];
    return self;
}

- (void)viewDidMoveToWindow {
    [super viewDidMoveToWindow];
    NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
    // Remove any prior observers (we may move between windows).
    [nc removeObserver:self name:NSWindowDidChangeScreenNotification object:nil];
    [nc removeObserver:self name:NSWindowDidChangeBackingPropertiesNotification object:nil];
    if (self.window) {
        // Catch screen changes — viewDidChangeBackingProperties only
        // fires when the BACKING SCALE changes (e.g. retina↔non-retina),
        // not when moving between two retina monitors of different
        // refresh rates / color spaces. We sync display id + scale
        // again on every screen change.
        [nc addObserver:self
               selector:@selector(windowDidChangeScreen:)
                   name:NSWindowDidChangeScreenNotification
                 object:self.window];
        [nc addObserver:self
               selector:@selector(windowDidChangeScreen:)
                   name:NSWindowDidChangeBackingPropertiesNotification
                 object:self.window];
        // Trigger the sync once to handle the initial placement.
        [self syncDisplayState];
    }
    if (!_surface) return;
    // Initial scale + size sync.
    CGFloat scale = self.window.backingScaleFactor;
    if (scale <= 0) scale = 1.0;
    ghostty_surface_set_content_scale(_surface, (double)scale, (double)scale);
    NSSize size = [self ghosttySafeSize];
    ghostty_surface_set_size(_surface,
                             (uint32_t)(size.width * scale),
                             (uint32_t)(size.height * scale));
    [self.window makeFirstResponder:self];
}

- (void)windowDidChangeScreen:(NSNotification *)note {
    [self syncDisplayState];
}

- (void)syncDisplayState {
    if (!_surface || !self.window) return;
    CGFloat scale = self.window.backingScaleFactor;
    if (scale <= 0) scale = 1.0;
    ghostty_surface_set_content_scale(_surface, (double)scale, (double)scale);
    NSSize size = [self ghosttySafeSize];
    ghostty_surface_set_size(_surface,
                             (uint32_t)(size.width * scale),
                             (uint32_t)(size.height * scale));
    NSScreen *screen = self.window.screen;
    if (screen) {
        NSNumber *displayId = screen.deviceDescription[@"NSScreenNumber"];
        if (displayId) {
            ghostty_surface_set_display_id(_surface, (uint32_t)displayId.unsignedIntValue);
        }
    }
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
}

- (void)appDidBecomeActive:(NSNotification *)note {
    if (_surface) ghostty_surface_set_focus(_surface, true);
}

- (void)appDidResignActive:(NSNotification *)note {
    if (_surface) ghostty_surface_set_focus(_surface, false);
}

// Show I-beam cursor over the terminal area — matches Terminal.app /
// iTerm2. AppKit calls this when the cursor enters/exits our view
// or the cursor rect mapping is invalidated.
- (void)resetCursorRects {
    [self addCursorRect:self.bounds cursor:NSCursor.IBeamCursor];
}

// --- Drag-and-drop --------------------------------------------------------

- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
    return NSDragOperationCopy;
}

- (BOOL)prepareForDragOperation:(id<NSDraggingInfo>)sender {
    return YES;
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    if (!_surface) return NO;
    NSPasteboard *pb = sender.draggingPasteboard;

    // Prefer file URLs — drop-to-paste-path is the main use case.
    NSArray<NSURL *> *urls =
        [pb readObjectsForClasses:@[NSURL.class]
                          options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
    if (urls.count > 0) {
        NSMutableString *joined = [NSMutableString string];
        for (NSURL *u in urls) {
            if (joined.length > 0) [joined appendString:@" "];
            // Quote paths with spaces — POSIX-shell safe single-quoting.
            NSString *p = u.path;
            if (!p) continue;
            BOOL needsQuote = [p containsString:@" "] ||
                              [p containsString:@"$"] ||
                              [p containsString:@"\""];
            if (needsQuote) {
                [joined appendString:@"'"];
                [joined appendString:[p stringByReplacingOccurrencesOfString:@"'"
                                                                  withString:@"'\\''"]];
                [joined appendString:@"'"];
            } else {
                [joined appendString:p];
            }
        }
        const char *utf8 = joined.UTF8String;
        if (utf8) ghostty_surface_text(_surface, utf8, strlen(utf8));
        return YES;
    }

    // Fall back to plain string drops.
    NSString *str = [pb stringForType:NSPasteboardTypeString];
    if (str.length > 0) {
        const char *utf8 = str.UTF8String;
        if (utf8) ghostty_surface_text(_surface, utf8, strlen(utf8));
        return YES;
    }
    return NO;
}

- (ghostty_surface_t)surface { return _surface; }

- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isFlipped { return YES; }
- (BOOL)wantsUpdateLayer { return NO; }

// Returns the size (in points) that ghostty should render into.
// Uses the window's `contentLayoutRect` (which excludes any safe-area
// regions like the title bar, fullscreen menu bar overlap, traffic
// light cutouts) clipped to our view's bounds. Without this, we were
// telling ghostty the surface was as tall as the view's frame —
// which under fullscreen / borderless modes silently extends UNDER
// the macOS menu bar, hiding 1-2 cell rows at the top of the terminal.
- (NSSize)ghosttySafeSize {
    NSSize bounds = self.bounds.size;
    if (!self.window) return bounds;
    NSRect cl = self.window.contentLayoutRect;
    // contentLayoutRect is in window-content coordinates. Clip our
    // bounds height to it so we never report area that's behind a
    // system bar.
    CGFloat h = MIN(bounds.height, cl.size.height);
    CGFloat w = MIN(bounds.width,  cl.size.width);
    return NSMakeSize(w, h);
}

- (void)setSurface:(ghostty_surface_t)surface {
    _surface = surface;
    // Register this view globally so action_cb / close_surface_cb
    // can find the NSWindow. Cleared on shutdown via setSurface(NULL).
    GhosttyRegisterHostView(surface ? (__bridge void *)self : NULL);
    if (_surface && self.window) {
        // Initial size + scale sync. `viewDidMoveToWindow` already fired
        // (we were added to the view hierarchy before the surface existed),
        // so we must push the geometry now or ghostty starts at a default
        // size and won't fill the contentView.
        CGFloat scale = self.window.backingScaleFactor;
        if (scale <= 0) scale = 1.0;
        ghostty_surface_set_content_scale(_surface, (double)scale, (double)scale);
        NSSize size = [self ghosttySafeSize];
        ghostty_surface_set_size(_surface,
                                 (uint32_t)(size.width  * scale),
                                 (uint32_t)(size.height * scale));
        // Tell ghostty the surface is focused — without this, cursor
        // doesn't blink, selection highlight doesn't render, mouse
        // hover cells don't update.
        ghostty_surface_set_focus(_surface, true);
    }
}

// (Diagnostic NSLog formerly inside setSurface: removed once the
// title-bar / safe-area sizing was confirmed working. Re-enable by
// adding NSLog(@"[ghostty-size] ...", ...) after the `set_size` call
// above if any future safe-area weirdness reappears.)

// Track focus changes via responder chain so we keep ghostty's
// focus state in sync. AppKit fires becomeFirstResponder /
// resignFirstResponder when focus moves between sibling views.
- (BOOL)becomeFirstResponder {
    BOOL r = [super becomeFirstResponder];
    if (r) {
        // Track the focused pane globally so split / clipboard / close
        // handlers route to the right surface.
        GhosttyRegisterHostView((__bridge void *)self);
        if (_surface) {
            GhosttyRegisterSurfaceForClipboard(_surface);
            ghostty_surface_set_focus(_surface, true);
            // Force a redraw so the cursor flips from hollow → solid
            // immediately rather than waiting for the next tick.
            ghostty_surface_refresh(_surface);
        }
    }
    return r;
}

- (BOOL)resignFirstResponder {
    BOOL r = [super resignFirstResponder];
    if (r && _surface) {
        ghostty_surface_set_focus(_surface, false);
        // Force a redraw so the cursor flips from solid → hollow.
        ghostty_surface_refresh(_surface);
    }
    return r;
}

- (void)updateTrackingAreas {
    if (_tracking) {
        [self removeTrackingArea:_tracking];
        _tracking = nil;
    }
    NSTrackingAreaOptions opts =
        NSTrackingMouseEnteredAndExited |
        NSTrackingMouseMoved |
        NSTrackingActiveInKeyWindow |
        NSTrackingInVisibleRect;
    _tracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect
                                              options:opts
                                                owner:self
                                             userInfo:nil];
    [self addTrackingArea:_tracking];
    [super updateTrackingAreas];
}

// (viewDidChangeBackingProperties moved below — handles both DPI
// and display-id sync in one place.)

// (Old viewDidMoveToWindow removed — superseded by the version that
// also wires NSWindowDidChangeScreen / BackingProperties observers.)

- (void)setFrameSize:(NSSize)newSize {
    [super setFrameSize:newSize];
    if (!_surface) return;
    CGFloat scale = self.window ? self.window.backingScaleFactor : 1.0;
    if (scale <= 0) scale = 1.0;
    NSSize safe = [self ghosttySafeSize];
    ghostty_surface_set_size(_surface,
                             (uint32_t)(safe.width  * scale),
                             (uint32_t)(safe.height * scale));
}

// Re-sync ghostty's size when the window's safe-area changes (e.g.
// entering/exiting fullscreen, menu-bar autohide changes). Without
// this, the safe area shrinks but ghostty keeps its old size and the
// top rows render under the menu bar.
- (void)windowDidChangeSafeArea {
    if (_surface && self.window) {
        CGFloat scale = self.window.backingScaleFactor;
        if (scale <= 0) scale = 1.0;
        NSSize safe = [self ghosttySafeSize];
        ghostty_surface_set_size(_surface,
                                 (uint32_t)(safe.width  * scale),
                                 (uint32_t)(safe.height * scale));
    }
}

// --- Keyboard --------------------------------------------------------------
// Builds a `ghostty_input_key_s` from the NSEvent and calls
// `ghostty_surface_key`. ghostty's input encoder owns the translation
// from (keyCode, mods) → escape sequences for Enter / Tab / arrows /
// function keys etc, so we MUST go through this path — not
// ghostty_surface_text — for those keys to work.
//
// Mirrors `vendor/ghostty/macos/Sources/Ghostty/NSEvent+Extension.swift`
// (`ghosttyKeyEvent`) and SurfaceView_AppKit.swift (`keyAction`).

static ghostty_input_mods_e ghostty_mods_from_ns(NSEventModifierFlags flags) {
    int m = GHOSTTY_MODS_NONE;
    if (flags & NSEventModifierFlagShift)   m |= GHOSTTY_MODS_SHIFT;
    if (flags & NSEventModifierFlagControl) m |= GHOSTTY_MODS_CTRL;
    if (flags & NSEventModifierFlagOption)  m |= GHOSTTY_MODS_ALT;
    if (flags & NSEventModifierFlagCommand) m |= GHOSTTY_MODS_SUPER;
    if (flags & NSEventModifierFlagCapsLock) m |= GHOSTTY_MODS_CAPS;
    return (ghostty_input_mods_e)m;
}

// Build a base ghostty_input_key_s from an NSEvent. Caller fills in
// text + composing fields and dispatches via ghostty_surface_key.
static ghostty_input_key_s build_key_event(NSEvent *event,
                                           ghostty_input_action_e action) {
    ghostty_input_key_s key_ev = {0};
    key_ev.action = action;
    key_ev.keycode = (uint32_t)event.keyCode;
    NSEventModifierFlags mods = event.modifierFlags;
    key_ev.mods = ghostty_mods_from_ns(mods);
    key_ev.consumed_mods = ghostty_mods_from_ns(
        mods & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand));
    NSString *unshifted = [event charactersByApplyingModifiers:0];
    if (unshifted.length > 0) {
        key_ev.unshifted_codepoint = (uint32_t)[unshifted characterAtIndex:0];
    }
    return key_ev;
}

// Dispatch with explicit committed text — used after interpretKeyEvents
// has accumulated IME-final text via insertText:.
static void send_key_event_text(ghostty_surface_t surface, NSEvent *event,
                                ghostty_input_action_e action,
                                const char *utf8, bool composing) {
    if (!surface) return;
    ghostty_input_key_s key_ev = build_key_event(event, action);
    key_ev.text = utf8;
    key_ev.composing = composing;
    ghostty_surface_key(surface, key_ev);
}

// Dispatch deriving text from event.characters (filters control +
// PUA codepoints to NULL so ghostty's encoder handles Enter/Tab/
// arrows / F-keys correctly via keycode lookup).
static void send_key_event_composing(ghostty_surface_t surface, NSEvent *event,
                                     ghostty_input_action_e action,
                                     bool composing);

static void send_key_event(ghostty_surface_t surface, NSEvent *event,
                           ghostty_input_action_e action) {
    send_key_event_composing(surface, event, action, false);
}

static void send_key_event_composing(ghostty_surface_t surface, NSEvent *event,
                                     ghostty_input_action_e action,
                                     bool composing) {
    if (!surface) return;
    ghostty_input_key_s key_ev = build_key_event(event, action);

    // build_key_event already populated mods + consumed_mods +
    // unshifted_codepoint. Below: derive text from event.characters,
    // filtering control + PUA so ghostty handles them via keycode.

    // (orphan-comment block below is harmless; left intentionally
    // to keep diff minimal.)
    // Ctrl/Cmd never contribute to text translation; everything else does
    // (matches the Swift heuristic).
    NSEventModifierFlags mods = event.modifierFlags;
    key_ev.mods = ghostty_mods_from_ns(mods);
    key_ev.consumed_mods = ghostty_mods_from_ns(
        mods & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand));

    // Unshifted codepoint = first scalar of `charactersByApplyingModifiers:`
    // with no modifier flags. Used by ghostty's bindings to match against
    // user-defined key bindings.
    NSString *unshifted = [event charactersByApplyingModifiers:0];
    if (unshifted.length > 0) {
        key_ev.unshifted_codepoint = (uint32_t)[unshifted characterAtIndex:0];
    }

    // For printable text we attach a UTF-8 buffer; for control chars
    // (0x00..0x1f) we leave text=NULL so ghostty's encoder emits the
    // proper escape sequences (Enter -> CR, Ctrl+C -> 0x03, etc).
    NSString *chars = event.characters;
    const char *utf8 = NULL;
    if (chars.length == 1) {
        unichar c = [chars characterAtIndex:0];
        // PUA range (0xF700..0xF8FF) is function keys — leave as null.
        if (c >= 0x20 && !(c >= 0xF700 && c <= 0xF8FF)) {
            utf8 = chars.UTF8String;
        }
    } else if (chars.length > 1) {
        utf8 = chars.UTF8String;
    }
    key_ev.text = utf8;
    key_ev.composing = composing;

    ghostty_surface_key(surface, key_ev);
}

- (void)keyDown:(NSEvent*)event {
    if (!_surface) { [super keyDown:event]; return; }
    ghostty_input_action_e act =
        event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;

    // Send the structured key event directly. This is the proven
    // working path. interpretKeyEvents-based IME routing is wired
    // (NSTextInputClient methods exist) but disabled here pending
    // a fix for a typing-regression observed when it's enabled.
    // To re-enable later, call interpretKeyEvents BEFORE this
    // dispatch and use the accumulator pattern (see git history).
    send_key_event(_surface, event, act);
}

// Cmd-modified keystrokes go through the application-level NSEvent
// monitor installed via `GhosttyInstallEventMonitor` (see below) — the
// monitor consumes them before AppKit ever dispatches into the
// responder chain, which is necessary on macOS 26 because tao/wry's
// downstream `extern "C"` keyDown handlers contain `.unwrap()` /
// `panic!` sites that abort the process. So we don't override
// performKeyEquivalent: here.

- (void)keyUp:(NSEvent*)event {
    if (!_surface) { [super keyUp:event]; return; }
    send_key_event(_surface, event, GHOSTTY_ACTION_RELEASE);
}

- (void)flagsChanged:(NSEvent*)event {
    if (!_surface) { [super flagsChanged:event]; return; }
    // For modifier-only events ghostty wants the full key event with
    // appropriate action. macOS sends flagsChanged on each modifier
    // press/release; we send PRESS — ghostty figures out the rest from
    // the mod bitmask.
    send_key_event(_surface, event, GHOSTTY_ACTION_PRESS);
}

// --- Mouse ----------------------------------------------------------------
//
// Forward AppKit mouse events into ghostty's input layer. Ghostty
// expects positions in POINTS in the view's local coordinate space,
// with origin at the TOP-LEFT (we set isFlipped:YES so NSView's
// coordinate space already matches that).

static ghostty_input_mouse_button_e ghostty_button_from_ns(NSInteger n) {
    switch (n) {
        case 0:  return GHOSTTY_MOUSE_LEFT;
        case 1:  return GHOSTTY_MOUSE_RIGHT;
        case 2:  return GHOSTTY_MOUSE_MIDDLE;
        case 3:  return GHOSTTY_MOUSE_FOUR;
        case 4:  return GHOSTTY_MOUSE_FIVE;
        default: return GHOSTTY_MOUSE_UNKNOWN;
    }
}

- (NSPoint)ghosttyMousePoint:(NSEvent*)event {
    return [self convertPoint:event.locationInWindow fromView:nil];
}

// Send the mouse position to ghostty. Mirrors Swift's mouseMoved
// reference (vendor/ghostty/macos/.../SurfaceView_AppKit.swift) — the
// position is in view-local POINTS with y=0 at the TOP. Our view is
// `isFlipped:YES`, so `convertPoint:fromView:nil` returns y=0-at-top
// directly without manual flipping.
static void send_mouse_pos(ghostty_surface_t surface, NSView *view, NSEvent *event) {
    if (!surface) return;
    NSPoint p = [view convertPoint:event.locationInWindow fromView:nil];
    ghostty_surface_mouse_pos(surface, (double)p.x, (double)p.y,
                              ghostty_mods_from_ns(event.modifierFlags));
}

- (void)mouseDown:(NSEvent*)event {
    // Reclaim keyboard focus on every click. WKWebView is a sibling
    // subview and will steal first-responder if it gets a hit; this
    // brings us back so subsequent keys reach the terminal.
    [self.window makeFirstResponder:self];
    if (!_surface) { [super mouseDown:event]; return; }
    // Update position FIRST so ghostty's selection-start tracking
    // knows where the click landed, then dispatch the button event.
    send_mouse_pos(_surface, self, event);
    ghostty_surface_mouse_button(_surface, GHOSTTY_MOUSE_PRESS,
                                 ghostty_button_from_ns(0),
                                 ghostty_mods_from_ns(event.modifierFlags));
}

- (void)mouseUp:(NSEvent*)event {
    if (!_surface) { [super mouseUp:event]; return; }
    send_mouse_pos(_surface, self, event);
    ghostty_surface_mouse_button(_surface, GHOSTTY_MOUSE_RELEASE,
                                 ghostty_button_from_ns(0),
                                 ghostty_mods_from_ns(event.modifierFlags));
}

- (void)rightMouseDown:(NSEvent*)event {
    if (!_surface) { [super rightMouseDown:event]; return; }
    send_mouse_pos(_surface, self, event);
    ghostty_surface_mouse_button(_surface, GHOSTTY_MOUSE_PRESS,
                                 ghostty_button_from_ns(1),
                                 ghostty_mods_from_ns(event.modifierFlags));
}

- (void)rightMouseUp:(NSEvent*)event {
    if (!_surface) { [super rightMouseUp:event]; return; }
    send_mouse_pos(_surface, self, event);
    ghostty_surface_mouse_button(_surface, GHOSTTY_MOUSE_RELEASE,
                                 ghostty_button_from_ns(1),
                                 ghostty_mods_from_ns(event.modifierFlags));
}

- (void)otherMouseDown:(NSEvent*)event {
    if (!_surface) { [super otherMouseDown:event]; return; }
    send_mouse_pos(_surface, self, event);
    ghostty_surface_mouse_button(_surface, GHOSTTY_MOUSE_PRESS,
                                 ghostty_button_from_ns(event.buttonNumber),
                                 ghostty_mods_from_ns(event.modifierFlags));
}

- (void)otherMouseUp:(NSEvent*)event {
    if (!_surface) { [super otherMouseUp:event]; return; }
    send_mouse_pos(_surface, self, event);
    ghostty_surface_mouse_button(_surface, GHOSTTY_MOUSE_RELEASE,
                                 ghostty_button_from_ns(event.buttonNumber),
                                 ghostty_mods_from_ns(event.modifierFlags));
}

- (void)mouseMoved:(NSEvent*)event {
    if (!_surface) { [super mouseMoved:event]; return; }
    send_mouse_pos(_surface, self, event);
}

- (void)mouseDragged:(NSEvent*)event {
    if (!_surface) { [super mouseDragged:event]; return; }
    send_mouse_pos(_surface, self, event);
}

- (void)rightMouseDragged:(NSEvent*)event { [self mouseDragged:event]; }
- (void)otherMouseDragged:(NSEvent*)event { [self mouseDragged:event]; }

- (void)scrollWheel:(NSEvent*)event {
    if (!_surface) { [super scrollWheel:event]; return; }
    double dx = (double)event.scrollingDeltaX;
    double dy = (double)event.scrollingDeltaY;
    BOOL precise = event.hasPreciseScrollingDeltas;
    if (precise) {
        // 2x speed multiplier matches ghostty's macOS reference
        // (subjective "feels right" tuning).
        dx *= 2;
        dy *= 2;
    }
    // Pack ghostty_input_scroll_mods_t (an int):
    //   bit 0   = precision
    //   bits 1+ = momentum phase (NSEventPhase mapped to ghostty's enum)
    int mods = 0;
    if (precise) mods |= 0b1;
    int momentum = 0;
    switch (event.momentumPhase) {
        case NSEventPhaseBegan:      momentum = GHOSTTY_MOUSE_MOMENTUM_BEGAN;      break;
        case NSEventPhaseStationary: momentum = GHOSTTY_MOUSE_MOMENTUM_STATIONARY; break;
        case NSEventPhaseChanged:    momentum = GHOSTTY_MOUSE_MOMENTUM_CHANGED;    break;
        case NSEventPhaseEnded:      momentum = GHOSTTY_MOUSE_MOMENTUM_ENDED;      break;
        case NSEventPhaseCancelled:  momentum = GHOSTTY_MOUSE_MOMENTUM_CANCELLED;  break;
        case NSEventPhaseMayBegin:   momentum = GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN;  break;
        default:                     momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;       break;
    }
    mods |= momentum << 1;
    ghostty_surface_mouse_scroll(_surface, dx, dy, (ghostty_input_scroll_mods_t)mods);
}

- (void)mouseExited:(NSEvent*)event {
    if (_surface) {
        // Negative coordinates tell ghostty the cursor left the
        // viewport — clears any hover-cell state (link underline,
        // mouse-mode cell hint, etc.).
        ghostty_surface_mouse_pos(_surface, -1.0, -1.0,
                                  ghostty_mods_from_ns(event.modifierFlags));
    }
}

- (void)mouseEntered:(NSEvent*)event {
    if (_surface) {
        NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
        ghostty_surface_mouse_pos(_surface, (double)p.x, (double)p.y,
                                  ghostty_mods_from_ns(event.modifierFlags));
    }
}

// Force-touch / trackpad pressure. Stage 0 is the initial press,
// stage 1 is light, stage 2 is hard (force click). Pressure is 0..1.
// Used by ghostty to trigger Quick Look on stage 2.
- (void)pressureChangeWithEvent:(NSEvent*)event {
    if (_surface) {
        ghostty_surface_mouse_pressure(_surface,
                                       (uint32_t)event.stage,
                                       (double)event.pressure);
    }
}

// Quick Look on the word under the cursor. AppKit calls this when
// the user does a force-click on a word (on a trackpad with Force
// Touch) or invokes the system Quick Look gesture. We pull the word
// from ghostty and present a Quick Look panel via NSAttributedString.
- (void)quickLookWithEvent:(NSEvent*)event {
    if (!_surface) { [super quickLookWithEvent:event]; return; }
    ghostty_text_s text = {0};
    if (!ghostty_surface_quicklook_word(_surface, &text) ||
        !text.text || text.text_len == 0) {
        [super quickLookWithEvent:event];
        return;
    }
    NSString *word = [[NSString alloc] initWithBytes:text.text
                                              length:text.text_len
                                            encoding:NSUTF8StringEncoding];
    ghostty_surface_free_text(_surface, &text);
    if (!word.length) return;
    NSDictionary *attrs = @{};
    NSAttributedString *attr = [[NSAttributedString alloc] initWithString:word
                                                               attributes:attrs];
    NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
    [self showDefinitionForAttributedString:attr atPoint:p];
}

// Notify ghostty when the window moves between monitors so it can
// pick the right Metal device + refresh rate for the new screen.
- (void)viewDidChangeBackingProperties {
    [super viewDidChangeBackingProperties];
    if (!_surface) return;
    CGFloat scale = self.window.backingScaleFactor;
    if (scale <= 0) scale = 1.0;
    ghostty_surface_set_content_scale(_surface, (double)scale, (double)scale);
    NSScreen *screen = self.window.screen;
    if (screen) {
        NSNumber *displayId = screen.deviceDescription[@"NSScreenNumber"];
        if (displayId) {
            ghostty_surface_set_display_id(_surface, (uint32_t)displayId.unsignedIntValue);
        }
    }
}

// Accept a click as activating + sending the click in one event,
// rather than the standard "first click activates, second click acts"
// behaviour. Important when the window isn't yet key — a single click
// should both focus it AND register as a terminal click.
- (BOOL)acceptsFirstMouse:(NSEvent*)event { return YES; }

// --- NSTextInputClient ---------------------------------------------------
//
// Implements the protocol so AppKit's input context drives our IME /
// dead-key composition. keyDown: calls interpretKeyEvents which in
// turn calls these methods. We forward marked text to
// `ghostty_surface_preedit` and accumulate committed text for the
// keyDown caller to dispatch as a single key event.

- (BOOL)hasMarkedText { return _markedText.length > 0; }
- (NSRange)markedRange { return _markedRange; }
- (NSRange)selectedRange { return _selectedRange; }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }

- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {
    NSString *s = nil;
    if ([string isKindOfClass:[NSAttributedString class]]) {
        s = ((NSAttributedString *)string).string;
    } else if ([string isKindOfClass:[NSString class]]) {
        s = (NSString *)string;
    }
    if (!s || s.length == 0) return;

    // Clear preedit because the IME committed and is no longer composing.
    [_markedText.mutableString setString:@""];
    _markedRange = NSMakeRange(NSNotFound, 0);
    if (_surface) ghostty_surface_preedit(_surface, NULL, 0);

    if (_imeAccumulator) {
        // We're inside keyDown's interpretKeyEvents — buffer for the
        // single composed key dispatch.
        [_imeAccumulator addObject:s];
    } else if (_surface) {
        // Out-of-band insertion (e.g. dictation, accessibility writing
        // tool). Send directly as committed text.
        const char *utf8 = s.UTF8String;
        if (utf8) ghostty_surface_text(_surface, utf8, strlen(utf8));
    }
}

- (void)setMarkedText:(id)string
        selectedRange:(NSRange)selectedRange
     replacementRange:(NSRange)replacementRange {
    NSString *s = nil;
    if ([string isKindOfClass:[NSAttributedString class]]) {
        s = ((NSAttributedString *)string).string;
    } else if ([string isKindOfClass:[NSString class]]) {
        s = (NSString *)string;
    }
    if (!s) s = @"";
    [_markedText.mutableString setString:s];
    _markedRange = NSMakeRange(0, s.length);
    _selectedRange = selectedRange;
    if (_surface) {
        const char *utf8 = s.UTF8String;
        ghostty_surface_preedit(_surface, utf8, utf8 ? strlen(utf8) : 0);
    }
}

- (void)unmarkText {
    [_markedText.mutableString setString:@""];
    _markedRange = NSMakeRange(NSNotFound, 0);
    if (_surface) ghostty_surface_preedit(_surface, NULL, 0);
}

- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range
                                                actualRange:(NSRangePointer)actualRange {
    return nil;
}

- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }

- (NSRect)firstRectForCharacterRange:(NSRange)range
                         actualRange:(NSRangePointer)actualRange {
    // Approx: cursor pixel area in screen coords. Without exact
    // ghostty cursor reporting we just return the view's frame —
    // enough for IME panel positioning to hover near the terminal.
    NSRect r = self.bounds;
    if (self.window) {
        r = [self.window convertRectToScreen:[self convertRect:r toView:nil]];
    }
    return r;
}

- (void)doCommandBySelector:(SEL)selector {
    // No-op: ghostty handles control keys via send_key_event /
    // ghostty_surface_key based on keycode; we don't need to map
    // Cocoa selectors (insertNewline:, deleteBackward:, etc.) to
    // anything — would just double-fire.
}

@end

// ---- C entry points -------------------------------------------------------

NSView* GhosttyHostViewCreate(NSRect frame) {
    return [[GhosttyHostView alloc] initWithFrame:frame];
}

void GhosttyHostViewSetSurface(NSView* view, ghostty_surface_t surface) {
    if (![view isKindOfClass:[GhosttyHostView class]]) return;
    [(GhosttyHostView*)view setSurface:surface];
}

void GhosttyHostViewClearSurface(NSView* view) {
    if (![view isKindOfClass:[GhosttyHostView class]]) return;
    [(GhosttyHostView*)view setSurface:NULL];
}

// ---- Action / close-surface dispatch ------------------------------------
//
// libghostty's action_cb fires for window-title updates, fullscreen
// toggles, ring bell, open URL, close window, mouse-shape changes,
// etc. We register the host NSView globally (single-window v1) so the
// handler can find the right NSWindow.

static _Atomic(void *) g_host_view = NULL;
static _Atomic(void *) g_app = NULL;

void GhosttyRegisterHostView(void *view) {
    atomic_store(&g_host_view, view);
}

void GhosttyRegisterApp(void *app) {
    atomic_store(&g_app, app);
}

static NSWindow *active_window(void) {
    NSView *v = (__bridge NSView *)atomic_load(&g_host_view);
    return v ? v.window : nil;
}

// ---- Tabs --------------------------------------------------------------
//
// Tabs are rendered by the HTML side (a <div> tab bar in the WKWebView).
// On the native side, every tab owns its own NSView "tab root" — either
// a single GhosttyHostView (1-pane tab) or an NSSplitView tree (multi-
// pane tab). All tab roots are direct subviews of `g_tab_container`,
// which sits below the HTML tab bar via `GhosttyTabContainerSetChromeInset`.
//
// Tab switching is `setHidden:` on roots — no surface teardown, PTYs and
// scrollback survive.
//
// Each tab root carries a stable integer id stored in `NSView.tag`. The
// id is what JS/Rust use to refer to a tab. Tags are assigned monotonically
// from `g_next_tab_id`.
//
// "Active tab" = the unhidden child of `g_tab_container`. The focused
// pane within that tab is tracked by `g_host_view` (preexisting).

static NSView *g_tab_container = nil;
static int g_next_tab_id = 1;
// Associated-object key used to attach a stable integer tab id to each
// tab-root view. `NSView.tag` is read-only (it's a get-only property);
// `objc_setAssociatedObject` is the standard sidecar storage.
static const void * const kTabIdKey = &kTabIdKey;

// Marker associated object set on every GhosttyHostView created via
// `perform_new_split`. Lets `GhosttyTabClose` distinguish split-
// created host views (whose ghostty_surface_t is owned only by the
// C side and must be freed here) from the tab's original host view
// (whose surface is owned by Rust's `PluginState.surfaces` and freed
// when the corresponding `View` is dropped).
static const void * const kSplitCreatedKey = &kSplitCreatedKey;
static BOOL is_split_created(NSView *v) {
    NSNumber *n = objc_getAssociatedObject(v, kSplitCreatedKey);
    return n ? n.boolValue : NO;
}

// Forward decl — `collect_hosts` is defined further down with the
// rest of the split-navigation helpers, but `GhosttyTabClose` (just
// below) needs it now to walk the closing subtree.
static void collect_hosts(NSView *root, NSMutableArray<GhosttyHostView *> *out);

// Forward declaration — defined in the split-navigation section below.
static GhosttyHostView *find_first_host_descendant(NSView *root);

static int tab_id_get(NSView *v) {
    NSNumber *n = objc_getAssociatedObject(v, kTabIdKey);
    return n ? n.intValue : 0;
}
static void tab_id_set(NSView *v, int id_) {
    objc_setAssociatedObject(v, kTabIdKey, @(id_),
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
// HTML chrome insets in points. Updated via GhosttyTabContainerSetChromeInset.
static CGFloat g_inset_top = 0, g_inset_right = 0, g_inset_bottom = 0, g_inset_left = 0;

// Tab event delivery — Rust installs a callback that emits Tauri events.
typedef void (*GhosttyTabEventFn)(int kind, int tab_id, const char *title);
// kind values map to TAB_EVENT_* below; kept in sync with macos.rs.
enum {
    TAB_EVENT_CREATED = 1,
    TAB_EVENT_FOCUSED = 2,
    TAB_EVENT_CLOSED  = 3,
    TAB_EVENT_TITLE   = 4,
};
static GhosttyTabEventFn g_tab_event_fn = NULL;

void GhosttyRegisterTabEventCallback(GhosttyTabEventFn fn) {
    g_tab_event_fn = fn;
}

static void emit_tab_event(int kind, int tab_id, NSString *title) {
    if (!g_tab_event_fn) return;
    const char *t = title ? title.UTF8String : NULL;
    g_tab_event_fn(kind, tab_id, t);
}

static NSView *root_for_tab_id(int tab_id) {
    if (!g_tab_container) return nil;
    for (NSView *child in g_tab_container.subviews) {
        if (tab_id_get(child) == tab_id) return child;
    }
    return nil;
}

// Compute the tab-container frame given the host contentView bounds and
// the current insets.
static NSRect tab_container_frame_in(NSView *contentView) {
    NSRect b = contentView.bounds;
    return NSMakeRect(g_inset_left,
                      g_inset_bottom,
                      MAX(0, b.size.width  - g_inset_left - g_inset_right),
                      MAX(0, b.size.height - g_inset_top  - g_inset_bottom));
}

// Ensure the tab container exists as a subview of `contentView`. Returns
// the (cached) container.
NSView *GhosttyTabContainerEnsure(NSView *contentView) {
    if (g_tab_container && g_tab_container.superview == contentView) {
        return g_tab_container;
    }
    g_tab_container = [[NSView alloc] initWithFrame:tab_container_frame_in(contentView)];
    g_tab_container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    g_tab_container.translatesAutoresizingMaskIntoConstraints = YES;
    [contentView addSubview:g_tab_container];
    return g_tab_container;
}

// Update the chrome insets and re-lay-out the container. Safe to call
// repeatedly as the HTML side resizes its bar.
void GhosttyTabContainerSetChromeInset(double top, double right, double bottom, double left) {
    g_inset_top    = (CGFloat)top;
    g_inset_right  = (CGFloat)right;
    g_inset_bottom = (CGFloat)bottom;
    g_inset_left   = (CGFloat)left;
    if (!g_tab_container) return;
    NSView *parent = g_tab_container.superview;
    if (!parent) return;
    g_tab_container.frame = tab_container_frame_in(parent);
}

// Add a new root view as a tab. Hides any previously active tab,
// makes the new one visible, assigns a fresh id (the NSView.tag), and
// emits TAB_EVENT_CREATED + TAB_EVENT_FOCUSED. Returns the assigned id.
int GhosttyTabAdd(NSView *root) {
    if (!g_tab_container || !root) return 0;
    int id_ = g_next_tab_id++;
    tab_id_set(root, id_);
    root.frame = g_tab_container.bounds;
    root.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    // Hide whichever tab was previously active.
    for (NSView *child in g_tab_container.subviews) child.hidden = YES;
    root.hidden = NO;
    [g_tab_container addSubview:root];
    emit_tab_event(TAB_EVENT_CREATED, id_, nil);
    emit_tab_event(TAB_EVENT_FOCUSED, id_, nil);
    return id_;
}

// Switch the active tab. Returns YES if found.
BOOL GhosttyTabFocus(int tab_id) {
    NSView *target = root_for_tab_id(tab_id);
    if (!target) return NO;
    for (NSView *child in g_tab_container.subviews) child.hidden = (child != target);
    // Restore focus to the (last-focused) pane inside this tab. We
    // pick the deepest GhosttyHostView left in the responder chain;
    // if none exists, just the first one.
    GhosttyHostView *pane = find_first_host_descendant(target);
    if (pane) [target.window makeFirstResponder:pane];
    emit_tab_event(TAB_EVENT_FOCUSED, tab_id, nil);
    return YES;
}

// Tear down a tab. Caller is responsible for freeing the ghostty
// surfaces under this tab BEFORE this call (we just unmount the views).
// Returns YES if the tab existed; sets *was_last to YES if no tabs
// remain after the close.
BOOL GhosttyTabClose(int tab_id, BOOL *was_last) {
    if (was_last) *was_last = NO;
    NSView *target = root_for_tab_id(tab_id);
    if (!target) return NO;
    BOOL was_active = !target.hidden;
    NSInteger idx = [g_tab_container.subviews indexOfObject:target];

    // BUG FIX (close-tab-with-split crash): walk the subtree under
    // `target` BEFORE removeFromSuperview so we can:
    //   1. Free every split-created ghostty surface (the original
    //      pane's surface stays alive — Rust's close_tab_native
    //      drops the matching `View` immediately after this call,
    //      which calls ghostty_surface_free for that one).
    //   2. Clear `_surface` on every host view in the subtree so
    //      AppKit's tear-down doesn't dispatch any further events
    //      through dangling surface pointers.
    //   3. Clear `g_host_view` if it currently points at any pane
    //      under the subtree we're tearing down — perform_goto_split
    //      / perform_new_split / perform_close_focused_pane would
    //      otherwise dereference a freed NSView on the next event.
    //
    // Wrinkle: `setSurface:NULL` has a side effect of unconditionally
    // calling `GhosttyRegisterHostView(NULL)` (clobbers g_host_view to
    // NULL even when self isn't the currently-focused pane). When the
    // user closes a non-active tab via the HTML `×` button, that side
    // effect would wrongly null out the global focus pointer for the
    // OTHER tab. We snapshot g_host_view, do the loop, then restore
    // if the subtree didn't actually contain the focused pane.
    {
        NSMutableArray<GhosttyHostView *> *panes = [NSMutableArray array];
        collect_hosts(target, panes);

        void *focusedBefore = atomic_load(&g_host_view);
        BOOL focusedInSubtree = NO;
        if (focusedBefore) {
            for (GhosttyHostView *p in panes) {
                if ((__bridge void *)p == focusedBefore) {
                    focusedInSubtree = YES;
                    break;
                }
            }
        }

        // (1) + (2) Free split surfaces, clear all _surface ivars.
        for (GhosttyHostView *pane in panes) {
            ghostty_surface_t s = pane.surface;
            if (is_split_created(pane)) {
                // Split-created — owned only by C. Free it here.
                [pane setSurface:NULL];
                if (s) ghostty_surface_free(s);
            } else {
                // Original (Rust-tracked) — only clear the ivar so
                // events stop routing through it. Rust calls
                // ghostty_surface_free when it drops the View
                // immediately after this function returns.
                [pane setSurface:NULL];
            }
        }

        // (3) Restore g_host_view if the closing subtree did not
        // contain the focused pane. If it did, leave at NULL — the
        // focused pane is gone, and the calling Rust path
        // (close_tab_native) will follow up by activating a
        // neighbour tab which re-registers via becomeFirstResponder.
        if (!focusedInSubtree) {
            atomic_store(&g_host_view, focusedBefore);
        }
    }

    [target removeFromSuperview];
    NSArray<NSView *> *remaining = g_tab_container.subviews;
    if (remaining.count == 0) {
        if (was_last) *was_last = YES;
        emit_tab_event(TAB_EVENT_CLOSED, tab_id, nil);
        return YES;
    }
    if (was_active) {
        // Pick the next-newest tab (or the previous one if we removed
        // the rightmost). idx might have been > remaining.count after
        // removal, so clamp.
        NSInteger pick = MIN((NSInteger)remaining.count - 1, MAX(0, idx));
        NSView *neighbour = remaining[pick];
        for (NSView *child in remaining) child.hidden = (child != neighbour);
        GhosttyHostView *pane = find_first_host_descendant(neighbour);
        if (pane) [neighbour.window makeFirstResponder:pane];
        emit_tab_event(TAB_EVENT_FOCUSED, tab_id_get(neighbour), nil);
    }
    emit_tab_event(TAB_EVENT_CLOSED, tab_id, nil);
    return YES;
}

// List currently-mounted tab ids (in left-to-right order). `out` must
// have room for at least `max` ints; returns count actually written.
int GhosttyTabList(int *out, int max) {
    if (!g_tab_container) return 0;
    int n = 0;
    for (NSView *child in g_tab_container.subviews) {
        if (n >= max) break;
        out[n++] = tab_id_get(child);
    }
    return n;
}

int GhosttyTabActiveId(void) {
    if (!g_tab_container) return 0;
    for (NSView *child in g_tab_container.subviews) {
        if (!child.hidden) return tab_id_get(child);
    }
    return 0;
}

// --- Split navigation ----------------------------------------------------
//
// `goto_split` finds the neighbouring GhosttyHostView in the requested
// direction and makes it firstResponder. We walk the NSSplitView tree:
// look at the parent split, find the current pane's index, step
// according to direction. If at the edge of the parent split, walk up
// to the next ancestor split and try again.

static GhosttyHostView *find_first_host_descendant(NSView *root) {
    if ([root isKindOfClass:[GhosttyHostView class]]) return (GhosttyHostView *)root;
    for (NSView *sub in root.subviews) {
        GhosttyHostView *h = find_first_host_descendant(sub);
        if (h) return h;
    }
    return nil;
}

// Collect all GhosttyHostView leaves in left-to-right top-to-bottom order.
static void collect_hosts(NSView *root, NSMutableArray<GhosttyHostView *> *out) {
    if ([root isKindOfClass:[GhosttyHostView class]]) {
        [out addObject:(GhosttyHostView *)root];
        return;
    }
    for (NSView *sub in root.subviews) collect_hosts(sub, out);
}

// Find the neighbour of `current` in the requested direction.
static GhosttyHostView *neighbour_pane(GhosttyHostView *current,
                                       ghostty_action_goto_split_e dir) {
    // BUG FIX (split nav crossed tab boundaries): the original code
    // walked `current.window.contentView` — the whole window — and
    // collected every GhosttyHostView under it, including those
    // inside hidden tabs (each tab's root NSView lives under
    // `g_tab_container` and is just toggled `.hidden = YES`, so its
    // descendants are still reachable and have valid frames). That
    // let cyclic nav (PREVIOUS/NEXT) loop into hidden tabs and
    // spatial nav (LEFT/RIGHT/UP/DOWN) pick a hidden pane as the
    // "best" target — visually the cursor stayed put, but keystrokes
    // routed to a pane in a different tab.
    //
    // Scope the search to the ACTIVE tab's root only. We find it by
    // walking up from `current` until we hit a direct child of
    // `g_tab_container`. Falls back to the whole window if the walk
    // can't find it (shouldn't happen in practice — if `current` is
    // focused it must live in the active tab — but keeps the prior
    // single-window-no-tabs behaviour as a safety net).
    NSView *scope = nil;
    if (g_tab_container) {
        NSView *walker = current;
        while (walker && walker.superview != g_tab_container) {
            walker = walker.superview;
        }
        scope = walker;
    }
    if (!scope) scope = current.window.contentView;

    NSMutableArray<GhosttyHostView *> *all = [NSMutableArray array];
    collect_hosts(scope, all);
    if (all.count <= 1) return nil;

    NSUInteger idx = [all indexOfObject:current];
    if (idx == NSNotFound) return nil;

    if (dir == GHOSTTY_GOTO_SPLIT_PREVIOUS) {
        return all[(idx + all.count - 1) % all.count];
    }
    if (dir == GHOSTTY_GOTO_SPLIT_NEXT) {
        return all[(idx + 1) % all.count];
    }

    // Spatial direction: pick the pane whose centre is in the
    // requested direction with the smallest screen-distance.
    NSRect curFrame = [current convertRect:current.bounds toView:nil];
    NSPoint curCentre = NSMakePoint(NSMidX(curFrame), NSMidY(curFrame));
    GhosttyHostView *best = nil;
    CGFloat bestDist = CGFLOAT_MAX;
    for (GhosttyHostView *cand in all) {
        if (cand == current) continue;
        NSRect f = [cand convertRect:cand.bounds toView:nil];
        NSPoint c = NSMakePoint(NSMidX(f), NSMidY(f));
        BOOL ok = NO;
        switch (dir) {
            case GHOSTTY_GOTO_SPLIT_LEFT:  ok = c.x < curCentre.x; break;
            case GHOSTTY_GOTO_SPLIT_RIGHT: ok = c.x > curCentre.x; break;
            // NSWindow coords have y=0 at bottom; "up" visually = larger y.
            case GHOSTTY_GOTO_SPLIT_UP:    ok = c.y > curCentre.y; break;
            case GHOSTTY_GOTO_SPLIT_DOWN:  ok = c.y < curCentre.y; break;
            default: break;
        }
        if (!ok) continue;
        CGFloat dx = c.x - curCentre.x;
        CGFloat dy = c.y - curCentre.y;
        CGFloat d = dx * dx + dy * dy;
        if (d < bestDist) {
            bestDist = d;
            best = cand;
        }
    }
    return best;
}

static void perform_goto_split(ghostty_action_goto_split_e dir) {
    NSView *focused = (__bridge NSView *)atomic_load(&g_host_view);
    if (![focused isKindOfClass:[GhosttyHostView class]]) return;
    GhosttyHostView *target = neighbour_pane((GhosttyHostView *)focused, dir);
    if (target) {
        [target.window makeFirstResponder:target];
    }
}

// --- Split implementation ------------------------------------------------
//
// On a NEW_SPLIT action we:
//   1. Find the focused GhosttyHostView (the one that issued the split).
//   2. Inherit the surface config off its existing surface.
//   3. Allocate a new GhosttyHostView and a new ghostty_surface_t bound
//      to it.
//   4. Insert the new view next to the focused view in an NSSplitView
//      with the requested orientation. Cross-orientation nesting works
//      via lazy NSSplitView wrapping.

static BOOL split_is_horizontal(ghostty_action_split_direction_e d) {
    // RIGHT/LEFT → side-by-side (vertical divider, isVertical:YES).
    // DOWN/UP    → top-bottom    (horizontal divider, isVertical:NO).
    return d == GHOSTTY_SPLIT_DIRECTION_RIGHT
        || d == GHOSTTY_SPLIT_DIRECTION_LEFT;
}

static BOOL split_inserts_after(ghostty_action_split_direction_e d) {
    // RIGHT/DOWN add the new view AFTER the focused one;
    // LEFT/UP add BEFORE.
    return d == GHOSTTY_SPLIT_DIRECTION_RIGHT
        || d == GHOSTTY_SPLIT_DIRECTION_DOWN;
}

static void perform_new_split(NSView *focused,
                              ghostty_action_split_direction_e dir) {
    NSLog(@"[ghostty] new_split: dir=%d focused=%@", dir, focused);
    if (![focused isKindOfClass:[GhosttyHostView class]]) {
        NSLog(@"[ghostty] new_split: focused not a host view, ignoring");
        return;
    }
    GhosttyHostView *focusedHost = (GhosttyHostView *)focused;
    ghostty_surface_t focusedSurface = focusedHost.surface;
    if (!focusedSurface) {
        NSLog(@"[ghostty] new_split: focused has no surface, ignoring");
        return;
    }

    void *appPtr = atomic_load(&g_app);
    if (!appPtr) {
        NSLog(@"[ghostty] new_split: no app registered, ignoring");
        return;
    }
    NSLog(@"[ghostty] new_split: app=%p, allocating new surface", appPtr);

    // Inherit config off the focused surface (working dir, env, etc.).
    ghostty_surface_config_s sc = ghostty_surface_inherited_config(
        focusedSurface, GHOSTTY_SURFACE_CONTEXT_SPLIT);

    // ghostty's `Surface.Options.scale_factor` defaults to 1.0 and
    // `newSurfaceOptions` (Zig side) does NOT override it. If we leave
    // it at 1.0, ghostty builds the initial font atlas at 1x DPI and
    // the GPU layer composites it scaled-up on a retina screen — the
    // new pane renders BIGGER and slightly blurry compared to the
    // original. Set it to the focused window's backingScaleFactor so
    // the atlas is minted at the correct resolution from the start.
    CGFloat scale = focused.window ? focused.window.backingScaleFactor : 2.0;
    if (scale <= 0) scale = 1.0;
    sc.scale_factor = (double)scale;

    // Force default font size on every new split. We don't want a
    // pane that the user has shrunk via Cmd+- to spawn child panes
    // at the same shrunk size — splits should start at the configured
    // default. (font_size=0 means "use config default" per ghostty.)
    sc.font_size = 0.0f;

    // Allocate the new host view first so we can pass its NSView*
    // to ghostty as the platform handle.
    NSRect frame = focused.bounds;
    GhosttyHostView *newHost = (GhosttyHostView *)GhosttyHostViewCreate(frame);
    sc.platform_tag = GHOSTTY_PLATFORM_MACOS;
    sc.platform.macos.nsview = (__bridge void *)newHost;

    ghostty_surface_t newSurface = ghostty_surface_new(
        (ghostty_app_t)appPtr, &sc);
    if (!newSurface) {
        NSLog(@"[ghostty] new_split: ghostty_surface_new failed");
        return;
    }
    [newHost setSurface:newSurface];

    // Insertion: if focused's superview is already an NSSplitView with
    // the requested orientation, append the new pane there. Otherwise
    // wrap focused in a fresh NSSplitView.
    BOOL wantHorizontal = split_is_horizontal(dir);
    NSView *parent = focused.superview;
    NSSplitView *targetSplit = nil;

    if ([parent isKindOfClass:[NSSplitView class]]
        && ((NSSplitView *)parent).isVertical == wantHorizontal) {
        targetSplit = (NSSplitView *)parent;
    } else {
        // Wrap: replace focused in its parent with a new split view
        // containing focused as the only pane, then we'll add newHost.
        targetSplit = [[NSSplitView alloc] initWithFrame:focused.frame];
        targetSplit.vertical = wantHorizontal;
        targetSplit.dividerStyle = NSSplitViewDividerStyleThin;
        targetSplit.autoresizingMask = focused.autoresizingMask;

        NSView *grandparent = parent;
        if (grandparent) {
            // BUG FIX (tab + split): if `focused` was the tab's root
            // (i.e. its parent IS the tab container), the tab_id is
            // attached to `focused`. After the wrap, `targetSplit`
            // becomes the new direct child of the tab container —
            // root_for_tab_id walks `g_tab_container.subviews` and
            // would see `targetSplit` (tab_id 0) instead of `focused`,
            // making the tab unselectable until the split is unwrapped
            // again. Transfer the tab_id BEFORE swapping. (The mirror
            // operation already exists on the unwrap side — see
            // perform_close_focused_pane lines 1446-1452 of the
            // pre-fix file: `int tag = tab_id_get(split); ...; if
            // (tag) tab_id_set(only, tag);`.)
            int tab_tag = tab_id_get(focused);

            // Remove focused from its parent, place split there, then
            // re-add focused as the split's first pane.
            [focused removeFromSuperview];
            [grandparent addSubview:targetSplit];
            [targetSplit addSubview:focused];

            if (tab_tag != 0 && grandparent == g_tab_container) {
                tab_id_set(targetSplit, tab_tag);
                // Leave tab_id on `focused` too — harmless (it's no
                // longer a direct child of g_tab_container, so
                // root_for_tab_id never queries it). Clearing would
                // lose the value if a future op rewrapped — keeping
                // it makes the move resilient to deeper nesting.
            }
        } else {
            // No parent (shouldn't happen) — just add to split.
            [targetSplit addSubview:focused];
        }
    }

    // BUG FIX (tab + split close): tag every split-created host view
    // so GhosttyTabClose can distinguish it from the original
    // Rust-tracked host view and free its surface during tab close.
    // Without this, splits created via cmd+d/cmd+\ would leak surfaces
    // when the parent tab closes (Rust's TabState.surfaces only
    // tracks the original spawn surface — see commands.rs::
    // spawn_tab_native), AND the dangling g_host_view → freed pane
    // pointer would crash the next event dispatch.
    objc_setAssociatedObject(newHost, kSplitCreatedKey, @YES,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);

    // Add newHost as a pane in the chosen split.
    NSArray<__kindof NSView *> *existing = targetSplit.arrangedSubviews;
    NSInteger focusedIdx = [existing indexOfObject:focused];
    if (focusedIdx == NSNotFound) focusedIdx = existing.count - 1;
    NSInteger insertIdx = split_inserts_after(dir) ? focusedIdx + 1 : focusedIdx;
    if (insertIdx < 0) insertIdx = 0;
    if (insertIdx > (NSInteger)targetSplit.arrangedSubviews.count) {
        insertIdx = targetSplit.arrangedSubviews.count;
    }
    [targetSplit insertArrangedSubview:newHost atIndex:insertIdx];

    // Equalise pane sizes. adjustSubviews alone doesn't reliably
    // produce equal panes; we set the divider position explicitly to
    // 50% of the split's primary axis and then let adjustSubviews
    // proportionally distribute any remaining children.
    [targetSplit adjustSubviews];
    if (targetSplit.arrangedSubviews.count == 2) {
        CGFloat axis = targetSplit.isVertical ? targetSplit.bounds.size.width
                                              : targetSplit.bounds.size.height;
        [targetSplit setPosition:axis * 0.5 ofDividerAtIndex:0];
    } else {
        // 3+ panes: distribute evenly along the primary axis.
        CGFloat axis = targetSplit.isVertical ? targetSplit.bounds.size.width
                                              : targetSplit.bounds.size.height;
        NSUInteger n = targetSplit.arrangedSubviews.count;
        for (NSUInteger i = 0; i < n - 1; i++) {
            [targetSplit setPosition:axis * (CGFloat)(i + 1) / (CGFloat)n
                    ofDividerAtIndex:i];
        }
    }

    // Move focus to the new pane so subsequent input goes there.
    // Explicitly resign the previous focus first because some
    // makeFirstResponder paths don't reliably propagate
    // resignFirstResponder to the prior responder when the new
    // responder is in a freshly added subview.
    if (focusedHost && [focusedHost.window firstResponder] == focusedHost) {
        // Force a focus-out so ghostty paints the prior pane's cursor
        // hollow before we swap.
        ghostty_surface_set_focus(focusedSurface, false);
    }
    [newHost.window makeFirstResponder:newHost];
}

// --- Tab action plumbing -------------------------------------------------
//
// Rust owns surface lifetime (the `View` wrapper calls
// `ghostty_surface_free` on drop), so action_cb forwards NEW_TAB /
// GOTO_TAB / CLOSE_TAB to Rust via a registered callback rather than
// doing the work in ObjC. Rust handles state mutation, allocation, and
// then calls back into the C tab APIs (GhosttyTabAdd / Focus / Close)
// to mount/unmount views.

typedef void (*GhosttyTabActionFn)(int kind, long arg);
enum {
    TAB_ACTION_NEW   = 1, // arg ignored
    TAB_ACTION_CLOSE = 2, // arg = tab_id, 0 = active
    TAB_ACTION_GOTO  = 3, // arg = ghostty GotoTab enum (positive = 1-based, neg = enum)
};
static GhosttyTabActionFn g_tab_action_fn = NULL;

void GhosttyRegisterTabActionCallback(GhosttyTabActionFn fn) {
    g_tab_action_fn = fn;
}

static void dispatch_tab_action(int kind, long arg) {
    if (g_tab_action_fn) g_tab_action_fn(kind, arg);
}

bool GhosttyHandleAction(void *app, void *target, void *action) {
    (void)app;
    if (!action) return false;
    ghostty_action_s *act = (ghostty_action_s *)action;
    ghostty_target_s *tgt = (ghostty_target_s *)target;
    NSWindow *win = active_window();
    switch (act->tag) {
        case GHOSTTY_ACTION_SET_TITLE:
        case GHOSTTY_ACTION_SET_TAB_TITLE: {
            const char *t = act->action.set_title.title;
            NSString *title = (t ? [NSString stringWithUTF8String:t] : nil);
            // Find the tab that owns the surface for this action so we
            // can emit a per-tab title event. The ghostty_target_s
            // gives us the surface; walk up to its tab root.
            int tab_id = 0;
            if (tgt && tgt->tag == GHOSTTY_TARGET_SURFACE) {
                ghostty_surface_t s = tgt->target.surface;
                // Find the GhosttyHostView whose _surface matches s.
                if (g_tab_container) {
                    for (NSView *child in g_tab_container.subviews) {
                        GhosttyHostView *match = nil;
                        // Recursive search.
                        NSMutableArray<NSView *> *stack = [@[child] mutableCopy];
                        while (stack.count > 0) {
                            NSView *cur = stack.lastObject;
                            [stack removeLastObject];
                            if ([cur isKindOfClass:[GhosttyHostView class]]
                                && [(GhosttyHostView *)cur surface] == s) {
                                match = (GhosttyHostView *)cur;
                                break;
                            }
                            for (NSView *sub in cur.subviews) [stack addObject:sub];
                        }
                        if (match) { tab_id = tab_id_get(child); break; }
                    }
                }
            }
            if (tab_id != 0 && title) {
                emit_tab_event(TAB_EVENT_TITLE, tab_id, title);
            }
            // Set NSWindow.title only for the active tab so the macOS
            // window-frame title reflects the visible terminal.
            if (win && title) {
                int active = GhosttyTabActiveId();
                if (active == 0 || tab_id == 0 || active == tab_id) {
                    win.title = title;
                }
            }
            return true;
        }
        case GHOSTTY_ACTION_TOGGLE_FULLSCREEN: {
            if (win) [win toggleFullScreen:nil];
            return true;
        }
        case GHOSTTY_ACTION_TOGGLE_MAXIMIZE: {
            if (win) [win zoom:nil];
            return true;
        }
        case GHOSTTY_ACTION_RING_BELL: {
            NSBeep();
            return true;
        }
        case GHOSTTY_ACTION_NEW_SPLIT: {
            NSLog(@"[ghostty] action: NEW_SPLIT direction=%d", act->action.new_split);
            NSView *focused = (__bridge NSView *)atomic_load(&g_host_view);
            if (focused) {
                perform_new_split(focused, act->action.new_split);
            }
            return true;
        }
        case GHOSTTY_ACTION_GOTO_SPLIT: {
            NSLog(@"[ghostty] action: GOTO_SPLIT direction=%d", act->action.goto_split);
            perform_goto_split(act->action.goto_split);
            return true;
        }
        case GHOSTTY_ACTION_NEW_TAB: {
            NSLog(@"[ghostty] action: NEW_TAB");
            dispatch_tab_action(TAB_ACTION_NEW, 0);
            return true;
        }
        case GHOSTTY_ACTION_GOTO_TAB: {
            NSLog(@"[ghostty] action: GOTO_TAB %ld", (long)act->action.goto_tab);
            dispatch_tab_action(TAB_ACTION_GOTO, (long)act->action.goto_tab);
            return true;
        }
        case GHOSTTY_ACTION_CLOSE_TAB: {
            NSLog(@"[ghostty] action: CLOSE_TAB");
            dispatch_tab_action(TAB_ACTION_CLOSE, 0);
            return true;
        }
        case GHOSTTY_ACTION_OPEN_URL: {
            const char *u = act->action.open_url.url;
            uintptr_t len = act->action.open_url.len;
            if (u && len > 0) {
                NSString *str = [[NSString alloc] initWithBytes:u
                                                          length:len
                                                        encoding:NSUTF8StringEncoding];
                NSURL *url = str ? [NSURL URLWithString:str] : nil;
                if (url) [[NSWorkspace sharedWorkspace] openURL:url];
            }
            return true;
        }
        case GHOSTTY_ACTION_CLOSE_WINDOW: {
            if (win) [win performClose:nil];
            return true;
        }
        case GHOSTTY_ACTION_QUIT: {
            [NSApp terminate:nil];
            return true;
        }
        // Render is fired ~every frame; ghostty handles its own
        // CADisplayLink internally — nothing for us to do.
        case GHOSTTY_ACTION_RENDER:
            return true;
        default:
            // Unhandled action tags: return true so ghostty knows we
            // saw the action even though we didn't act on it. Returning
            // false would cause ghostty to retry / fall through.
            return true;
    }
}

// Close-surface cascade. ghostty's `close_surface` keybind action (the
// default Cmd+W) and the close_surface_cb both end up here. We pick one
// of three behaviours depending on the focused pane's location:
//
//   1. Pane is part of a multi-pane split → remove just this pane,
//      collapse the parent NSSplitView if it's left with one child.
//   2. Pane is the only pane in its tab → ask Rust to close the tab
//      (which honours `close_window_on_last_tab`).
//   3. No focused pane → fall back to closing the window.
//
// This is the path Cmd+W takes; the explicit JS-driven close path
// (terminal_close_tab from the HTML × button) skips this and goes
// straight to step 2.
static void perform_close_focused_pane(void) {
    NSView *focused = (__bridge NSView *)atomic_load(&g_host_view);
    if (![focused isKindOfClass:[GhosttyHostView class]]) {
        // No focused pane — fall back to old window-close behaviour.
        NSWindow *win = active_window();
        if (win) [win performClose:nil];
        return;
    }
    GhosttyHostView *pane = (GhosttyHostView *)focused;
    NSView *parent = pane.superview;

    // Case 1: parent is an NSSplitView with siblings.
    if ([parent isKindOfClass:[NSSplitView class]]
        && parent.subviews.count > 1) {
        // Free this pane's surface, remove from split, then move
        // focus to a sibling.
        ghostty_surface_t s = pane.surface;
        [pane setSurface:NULL];
        if (s) ghostty_surface_free(s);
        NSUInteger idx = [parent.subviews indexOfObject:pane];
        [pane removeFromSuperview];
        // Re-equalise remaining panes.
        NSSplitView *split = (NSSplitView *)parent;
        [split adjustSubviews];
        NSUInteger n = split.arrangedSubviews.count;
        if (n >= 2) {
            CGFloat axis = split.isVertical ? split.bounds.size.width
                                            : split.bounds.size.height;
            for (NSUInteger i = 0; i < n - 1; i++) {
                [split setPosition:axis * (CGFloat)(i + 1) / (CGFloat)n
                  ofDividerAtIndex:i];
            }
        }
        // If only one child remains, unwrap the split — replace it
        // with its sole child in the grandparent.
        if (n == 1) {
            NSView *only = split.arrangedSubviews.firstObject;
            NSView *grand = split.superview;
            if (grand) {
                only.frame = split.frame;
                only.autoresizingMask = split.autoresizingMask;
                // Preserve tab id if the split was a tab root.
                int tag = tab_id_get(split);
                [only removeFromSuperview];
                [split removeFromSuperview];
                [grand addSubview:only];
                if (tag) tab_id_set(only, tag);
            }
        }
        // Move focus to the sibling that took our place.
        NSView *neighbour;
        if (idx < parent.subviews.count) {
            neighbour = parent.subviews[idx];
        } else {
            neighbour = parent.subviews.lastObject;
        }
        GhosttyHostView *next = find_first_host_descendant(neighbour);
        if (next) [next.window makeFirstResponder:next];
        return;
    }

    // Case 2: only pane in this tab — dispatch CLOSE_TAB to Rust which
    // handles the close-window-on-last-tab policy + Tauri events.
    dispatch_tab_action(TAB_ACTION_CLOSE, 0);
}

void GhosttyHandleCloseSurface(bool process_alive) {
    (void)process_alive; // v1: no confirm dialog on dirty exit
    perform_close_focused_pane();
}

// ---- Application-level Cmd-key monitor ----------------------------------
//
// AppKit dispatch for Cmd-modified keyDown events on macOS 26 ends up
// re-entering Rust extern "C" code in tao/wry (specifically a
// `MainThreadMarker::new().unwrap()` in WryWebViewParent::keyDown and a
// thread-identity panic in tao::AppState::queue_event reachable via tao's
// view::keyDown). Both fire inside `extern "C"` ObjC method bodies, so
// the panic crosses the C ABI boundary and aborts via
// `panic_cannot_unwind` with no recoverable error message.
//
// `+[NSEvent addLocalMonitorForEventsMatchingMask:handler:]` runs the
// supplied handler BEFORE AppKit dispatches the event into the responder
// chain. Returning nil consumes the event; returning the event lets
// dispatch proceed normally. We use this to intercept Cmd-modified
// keyDowns — forwarding them straight to ghostty and consuming them so
// the buggy dispatch path never runs.

static id g_event_monitor = nil;
static ghostty_surface_t g_monitor_surface = NULL;

// Embedding-host passthrough callback. Wired by Rust at terminal_new
// time; fires when the NSEvent monitor sees a chord we want the
// embedding host (zen-tools) to handle instead of forwarding to
// ghostty. Currently used for the distraction-free toggle
// (cmd+opt+f), which the host hides its TitleBar in response to.
//
// String values are stable identifiers chosen by this module
// (currently just "cmd-opt-f"). Hosts that don't care can ignore
// the callback entirely; the chord is consumed regardless so it
// doesn't reach ghostty as a stray keystroke.
typedef void (*GhosttyHostKeyHookFn)(const char *chord);
static GhosttyHostKeyHookFn g_host_key_hook_fn = NULL;

void GhosttyRegisterHostKeyHookCallback(GhosttyHostKeyHookFn fn) {
    g_host_key_hook_fn = fn;
}

void GhosttyInstallEventMonitor(ghostty_surface_t surface) {
    g_monitor_surface = surface;
    if (g_event_monitor) return; // idempotent — installed once per process
    g_event_monitor = [NSEvent
        addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
        handler:^NSEvent *(NSEvent *event) {
            // Only intercept Cmd-modified events. Plain keys + Ctrl/Alt
            // are delivered through the normal responder chain to our
            // GhosttyHostView's keyDown:, which works fine.
            if (!(event.modifierFlags & NSEventModifierFlagCommand)) {
                return event;
            }

            // Embedding-host passthrough chords. Checked BEFORE the
            // ghostty forward so they never reach ghostty as
            // unhandled keystrokes. Chord set is intentionally tiny
            // (one entry today); each new chord is one branch here.
            //
            // cmd+opt+f → host distraction-free toggle. Match
            // exactly cmd+opt (no shift / ctrl) so cmd+opt+shift+f
            // and friends still flow to ghostty.
            NSEventModifierFlags devMods = event.modifierFlags &
                (NSEventModifierFlagCommand | NSEventModifierFlagOption |
                 NSEventModifierFlagShift   | NSEventModifierFlagControl);
            NSString *chars = event.charactersIgnoringModifiers;
            if (devMods == (NSEventModifierFlagCommand | NSEventModifierFlagOption)
                && [chars isEqualToString:@"f"]) {
                if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-opt-f");
                return nil; // consume — do NOT forward to ghostty
            }

            // Look up the CURRENTLY focused pane (not the cached one
            // from install time). With splits, the focused surface
            // changes — without this lookup, every Cmd-shortcut
            // (Cmd+=/-/0 font size, Cmd+W close, Cmd+C copy) targets
            // pane #1 forever.
            ghostty_surface_t target = NULL;
            void *vp = atomic_load(&g_host_view);
            if (vp) {
                NSView *view = (__bridge NSView *)vp;
                if ([view isKindOfClass:[GhosttyHostView class]]) {
                    target = [(GhosttyHostView *)view surface];
                }
            }
            if (!target) target = g_monitor_surface;
            if (target) send_key_event(target, event, GHOSTTY_ACTION_PRESS);
            return nil;
        }];
}

void GhosttyRemoveEventMonitor(void) {
    if (g_event_monitor) {
        [NSEvent removeMonitor:g_event_monitor];
        g_event_monitor = nil;
    }
    g_monitor_surface = NULL;
}

// ---- Disarm wry's panicking keyDown -------------------------------------
//
// `WryWebViewParent::key_down` (wry-0.55.0/src/wkwebview/class/
// wry_web_view_parent.rs:30-38) does:
//
//   let mtm = MainThreadMarker::new().unwrap();
//   let app = NSApplication::sharedApplication(mtm);
//   if let Some(menu) = app.mainMenu() { menu.performKeyEquivalent(event); }
//
// On macOS 26, AppKit's reentrant Cmd-key dispatch invokes this method
// in a context where `pthread_main_np()` returns 0, so the unwrap
// panics inside an `extern "C"` ObjC method body. The Rust runtime
// catches the unwind at the C ABI boundary and aborts via
// `panic_cannot_unwind`.
//
// We replace the IMP with a no-op via the Objective-C runtime. Tauri
// terminal apps have no mainMenu, so the original body had no effect
// for us anyway. Safe to call multiple times.

static void wry_key_down_noop(id self, SEL _cmd, NSEvent *event) {
    (void)self; (void)_cmd; (void)event;
}

static BOOL wry_perform_key_equivalent_noop(id self, SEL _cmd, NSEvent *event) {
    (void)self; (void)_cmd; (void)event;
    return NO;
}

// Walk the runtime's class list and find every class that's a subclass
// of NSView whose name contains "Wry" (case-insensitive). Replace its
// keyDown: IMP if it has one. This handles objc2's name-mangling — the
// concrete class name registered by `define_class!` is implementation-
// defined and varies between objc2 versions.
void GhosttyDisarmWryParentKeyDown(void) {
    SEL sel_keydown = sel_registerName("keyDown:");
    SEL sel_pke     = sel_registerName("performKeyEquivalent:");
    int count = objc_getClassList(NULL, 0);
    if (count <= 0) {
        NSLog(@"[ghostty] disarm: objc_getClassList returned %d, skipping", count);
        return;
    }
    Class *classes = (Class *)malloc(sizeof(Class) * (size_t)count);
    if (!classes) return;
    objc_getClassList(classes, count);

    Class nsview_cls = objc_getClass("NSView");
    int patched_keydown = 0;
    int patched_pke = 0;
    for (int i = 0; i < count; i++) {
        Class cls = classes[i];
        const char *name = class_getName(cls);
        if (!name) continue;
        // Cheap case-insensitive substring check for "wry".
        BOOL has_wry = NO;
        for (const char *p = name; *p; p++) {
            if ((p[0] == 'W' || p[0] == 'w')
                && (p[1] == 'R' || p[1] == 'r')
                && (p[2] == 'Y' || p[2] == 'y')) {
                has_wry = YES; break;
            }
        }
        if (!has_wry) continue;
        // Must descend from NSView so swizzling its keyDown: matters.
        BOOL is_view = NO;
        for (Class c = cls; c; c = class_getSuperclass(c)) {
            if (c == nsview_cls) { is_view = YES; break; }
        }
        if (!is_view) continue;
        // Enumerate the class's directly-defined methods so we don't
        // accidentally swizzle NSView/WKWebView's inherited IMPs.
        unsigned int mcount = 0;
        Method *methods = class_copyMethodList(cls, &mcount);
        BOOL has_keydown = NO;
        BOOL has_pke = NO;
        for (unsigned int j = 0; j < mcount; j++) {
            SEL s = method_getName(methods[j]);
            if (sel_isEqual(s, sel_keydown))  has_keydown = YES;
            if (sel_isEqual(s, sel_pke))      has_pke = YES;
        }
        free(methods);

        if (has_keydown) {
            Method m = class_getInstanceMethod(cls, sel_keydown);
            if (m) {
                method_setImplementation(m, (IMP)wry_key_down_noop);
                NSLog(@"[ghostty] disarmed %s.keyDown:", name);
                patched_keydown++;
            }
        }
        if (has_pke) {
            Method m = class_getInstanceMethod(cls, sel_pke);
            if (m) {
                method_setImplementation(m, (IMP)wry_perform_key_equivalent_noop);
                NSLog(@"[ghostty] disarmed %s.performKeyEquivalent:", name);
                patched_pke++;
            }
        }
    }
    free(classes);
    NSLog(@"[ghostty] disarm summary: keyDown=%d performKeyEquivalent=%d",
          patched_keydown, patched_pke);
}

// ---- Wakeup → app_tick dispatch ------------------------------------------
//
// libghostty fires its `wakeup_cb` from internal threads to ask the
// host to call `ghostty_app_tick` on the main thread. Without that
// tick, work queued by ghostty (rendering, scrollback management,
// PTY drain) never runs and the terminal freezes after a few hundred
// lines of output.
//
// We can't capture the app pointer in the Rust wakeup closure
// because the closure is constructed BEFORE `ghostty_app_new` returns
// the pointer. So we stash the pointer in this atomic at App::new
// time and the trampoline reads it from here.

static _Atomic(void *) g_wakeup_app = NULL;

void GhosttyRegisterAppForWakeup(void *app) {
    atomic_store(&g_wakeup_app, app);
}

void GhosttyDispatchAppTick(void) {
    void *app = atomic_load(&g_wakeup_app);
    if (!app) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        // Re-read in case the app was unregistered between dispatch
        // and execution.
        void *current = atomic_load(&g_wakeup_app);
        if (current) ghostty_app_tick((ghostty_app_t)current);
    });
}

// ---- Clipboard read/write -----------------------------------------------
//
// Implements the runtime's read_clipboard_cb / write_clipboard_cb in
// terms of NSPasteboard. Cmd+C / Cmd+V (and the OSC 52 sequence)
// route through ghostty's input layer, hit the binding action
// `copy_to_clipboard` / `paste_from_clipboard`, and end up here.

static _Atomic(void *) g_clipboard_surface = NULL;

void GhosttyRegisterSurfaceForClipboard(ghostty_surface_t surface) {
    atomic_store(&g_clipboard_surface, surface);
}

static NSPasteboard *clipboard_for_kind(int kind) {
    // GHOSTTY_CLIPBOARD_SELECTION (= 1) maps to NSPasteboardNameFind
    // — that's macOS's closest analogue to X11's primary selection
    // (used by Spotlight / Find UI but addressable). Standard maps
    // to the general pasteboard. This gives X11-style middle-click-
    // paste users a separate buffer from their Cmd+C copy.
    if (kind == GHOSTTY_CLIPBOARD_SELECTION) {
        return [NSPasteboard pasteboardWithName:NSPasteboardNameFind];
    }
    return NSPasteboard.generalPasteboard;
}

bool GhosttyHandleReadClipboard(int kind, void *state) {
    NSPasteboard *pb = clipboard_for_kind(kind);
    NSString *text = [pb stringForType:NSPasteboardTypeString];
    if (!text || text.length == 0) return false;
    void *surface = atomic_load(&g_clipboard_surface);
    if (!surface) return false;
    const char *utf8 = text.UTF8String;
    if (!utf8) return false;
    ghostty_surface_complete_clipboard_request(
        (ghostty_surface_t)surface, utf8, state, /* confirmed= */ false);
    return true;
}

void GhosttyHandleWriteClipboard(int kind, const void *content_ptr,
                                 unsigned long n, bool confirm) {
    (void)confirm; // v1 trusts the host implicitly
    if (!content_ptr || n == 0) return;
    const ghostty_clipboard_content_s *content =
        (const ghostty_clipboard_content_s *)content_ptr;
    NSPasteboard *pb = clipboard_for_kind(kind);
    // Find the first text/plain entry — that's what users actually
    // paste into other apps. Other MIME types are out of scope for v1.
    for (unsigned long i = 0; i < n; i++) {
        if (!content[i].mime || !content[i].data) continue;
        if (strcmp(content[i].mime, "text/plain") != 0) continue;
        NSString *str = [NSString stringWithUTF8String:content[i].data];
        if (!str) continue;
        [pb declareTypes:@[NSPasteboardTypeString] owner:nil];
        [pb setString:str forType:NSPasteboardTypeString];
        return;
    }
}

// ---- Disarm tao's sendEvent overrides ------------------------------------
//
// Tao registers two NSWindow / NSApplication subclasses ("TaoWindow",
// "TaoApp") and overrides their `sendEvent:` with Rust `extern "C"`
// IMPs that call `event.r#type()` / `event.modifierFlags()`. On
// macOS 26, AppKit can hand the override events whose type integer is
// not in the old objc2-app-kit binding's enum, and the call panics
// inside the `extern "C"` body — hitting `panic_cannot_unwind` and
// aborting the process. We replace the IMPs with pure-ObjC
// pass-throughs to super.

#import <objc/message.h>

// We capture the ORIGINAL NSWindow / NSApplication sendEvent: IMPs and
// invoke them directly from our replacement IMPs. This is safer than
// `objc_msgSendSuper` (which has subtle arm64 ABI considerations and
// broke the event loop in our earlier attempt). The default
// NSApplication / NSWindow IMPs ARE the dispatchers tao was wrapping;
// calling them directly skips tao's panic-prone Rust wrapper while
// preserving event-dispatch behavior.
typedef void (*SendEventIMP)(id, SEL, id);
static SendEventIMP g_original_nswindow_send_event = NULL;
static SendEventIMP g_original_nsapp_send_event = NULL;

static void tao_window_safe_send_event(id self, SEL _cmd, id event) {
    if (g_original_nswindow_send_event) {
        g_original_nswindow_send_event(self, _cmd, event);
    }
}

static void tao_app_safe_send_event(id self, SEL _cmd, id event) {
    if (g_original_nsapp_send_event) {
        g_original_nsapp_send_event(self, _cmd, event);
    }
}

void GhosttyDisarmTaoSendEvent(void) {
    SEL sel = sel_registerName("sendEvent:");

    // Capture NSWindow's and NSApplication's original sendEvent: IMPs.
    // Both are the actual system dispatchers tao subclassed; forwarding
    // to them from our replacements preserves correct dispatch.
    if (!g_original_nswindow_send_event) {
        Class nswCls = objc_getClass("NSWindow");
        if (nswCls) {
            Method nsm = class_getInstanceMethod(nswCls, sel);
            if (nsm) {
                g_original_nswindow_send_event =
                    (SendEventIMP)method_getImplementation(nsm);
                NSLog(@"[ghostty] captured NSWindow.sendEvent: IMP @ %p",
                      g_original_nswindow_send_event);
            }
        }
    }
    if (!g_original_nsapp_send_event) {
        Class appCls = objc_getClass("NSApplication");
        if (appCls) {
            Method nsm = class_getInstanceMethod(appCls, sel);
            if (nsm) {
                g_original_nsapp_send_event =
                    (SendEventIMP)method_getImplementation(nsm);
                NSLog(@"[ghostty] captured NSApplication.sendEvent: IMP @ %p",
                      g_original_nsapp_send_event);
            }
        }
    }
    if (!g_original_nswindow_send_event || !g_original_nsapp_send_event) {
        NSLog(@"[ghostty] disarm: failed to capture sendEvent: IMPs — "
              @"aborting swizzle to avoid breaking event loop");
        return;
    }

    // TaoWindow → forward to NSWindow IMP.
    {
        Class cls = objc_getClass("TaoWindow");
        if (cls) {
            Method m = class_getInstanceMethod(cls, sel);
            if (m) {
                method_setImplementation(m, (IMP)tao_window_safe_send_event);
                NSLog(@"[ghostty] disarmed TaoWindow.sendEvent: "
                      @"(forwards to NSWindow IMP)");
            }
        } else {
            NSLog(@"[ghostty] disarm: TaoWindow class not found");
        }
    }

    // TaoApp → forward to NSApplication IMP. Critical: this preserves
    // the system event dispatcher (which is NSApplication.sendEvent:
    // itself — tao only added a special-case for NSKeyUp+Cmd that we
    // don't need).
    {
        Class cls = objc_getClass("TaoApp");
        if (cls) {
            Method m = class_getInstanceMethod(cls, sel);
            if (m) {
                method_setImplementation(m, (IMP)tao_app_safe_send_event);
                NSLog(@"[ghostty] disarmed TaoApp.sendEvent: "
                      @"(forwards to NSApplication IMP)");
            }
        } else {
            NSLog(@"[ghostty] disarm: TaoApp class not found");
        }
    }
}
