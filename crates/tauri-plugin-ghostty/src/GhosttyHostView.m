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
#import <limits.h>

// Forward declaration — `g_host_view` is a `static _Atomic(void *)`
// defined further down alongside the other action-state slots, but
// `resignFirstResponder` in the @implementation block below needs to
// clear the slot when the resigning view is the cached one. We can't
// `extern`-forward-declare a `static` (the qualifiers conflict), so we
// expose the conditional-clear via this small helper instead — it's
// defined after the slot itself further down the file.
static void clear_host_view_if_matches(void *expected);
static void clear_last_host_view_if_matches(void *expected);
static void emit_terminal_interaction_event(ghostty_surface_t surface);
static ghostty_surface_t active_tab_fallback_surface(void);

@class GhosttyHostView;
@interface GhosttySplitView : NSSplitView
@end

@interface GhosttyPaneDragHandle : NSView <NSDraggingSource>
@property(nonatomic, weak) GhosttyHostView *hostView;
@property(nonatomic, assign) BOOL dragging;
@end

typedef NS_ENUM(NSInteger, GhosttyPaneDropZone) {
    GhosttyPaneDropZoneNone = 0,
    GhosttyPaneDropZoneTop,
    GhosttyPaneDropZoneBottom,
    GhosttyPaneDropZoneLeft,
    GhosttyPaneDropZoneRight,
};

static NSPasteboardType const GhosttyPanePasteboardType =
    @"com.zen-tools.ghostty-pane-id";
static __weak GhosttyHostView *g_active_pane_drag_source = nil;
static NSString *g_active_pane_drag_identifier = nil;
static GhosttyHostView *host_for_drag_identifier(NSString *identifier);
static NSView *tab_root_for_descendant(NSView *view);
static BOOL move_pane_to_drop_zone(GhosttyHostView *source,
                                   GhosttyHostView *destination,
                                   GhosttyPaneDropZone zone);

// Walk the NSView tree under `root` and append every GhosttyHostView
// descendant to `out`. Used by the resize / fullscreen handler to
// re-sync every live ghostty surface in the tree, not just self.
// Defined further down (next to the other tab-tree helpers).
static void collect_hosts(NSView *root, NSMutableArray<GhosttyHostView *> *out);

// Reapply the cached chrome inset (snaps the tab container's frame
// to the current contentView bounds) and push a fresh size + scale
// to every live `GhosttyHostView` in the tree. The fallback view is
// used when no tab container exists yet (very first surface).
//
// Defined alongside the static globals further down so it has
// visibility into `g_tab_container` and `g_inset_*`.
static void resync_chrome_and_surfaces(GhosttyHostView *fallback);

// Tentative forward declaration — the explicit definition (with
// initialiser) lives alongside the other tab-state statics further
// down the file. Needed here so -ghosttySafeSize can read the value
// without moving the method past the globals block.
static CGFloat g_inset_top;
static BOOL g_window_resync_scheduled = NO;

@interface GhosttyHostView : NSView <NSTextInputClient, NSSearchFieldDelegate> {
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
    GhosttyPaneDragHandle      *_dragHandle;
    CALayer                    *_dropIndicator;
    NSString                   *_dragIdentifier;
    GhosttyPaneDropZone         _shownDropZone;
    NSView                     *_searchOverlay;
    NSSearchField              *_searchField;
    NSTextField                *_searchCount;
    NSButton                   *_searchPreviousButton;
    NSButton                   *_searchNextButton;
    NSButton                   *_searchCloseButton;
    NSUInteger                  _searchGeneration;
    NSInteger                   _searchTotal;
    NSInteger                   _searchSelected;
    BOOL                        _searchQueryPending;
}
- (ghostty_surface_t)surface; // Accessor for C-side helpers.
- (NSString *)dragIdentifier;
- (void)layoutPaneDragHandle;
- (void)setPaneDragHandleVisible:(BOOL)visible;
- (void)beginNativeSearchWithNeedle:(NSString *)needle;
- (void)endNativeSearch;
- (BOOL)nativeSearchOwnsFocus;
- (void)updateNativeSearchTotal:(NSInteger)total;
- (void)updateNativeSearchSelected:(NSInteger)selected;
// Exposed so the resize / fullscreen notification handler can
// re-sync every live host view in the tree (split panes etc.) in
// one pass via `collect_hosts` — not just `self`.
- (NSSize)ghosttySafeSize;
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
    _dragIdentifier = NSUUID.UUID.UUIDString;
    _shownDropZone = GhosttyPaneDropZoneNone;
    _searchGeneration = 0;
    _searchTotal = -1;
    _searchSelected = -1;
    _searchQueryPending = NO;
    self.wantsLayer = YES;
    self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

    // A tiny, native-only drag target mirrors Ghostty 1.3's macOS
    // split grab handle. It stays hidden until the pointer enters the
    // upper hover band, so normal terminal selection keeps the full
    // surface area everywhere else.
    _dragHandle = [[GhosttyPaneDragHandle alloc] initWithFrame:NSZeroRect];
    _dragHandle.hostView = self;
    _dragHandle.wantsLayer = YES;
    _dragHandle.hidden = YES;
    [self addSubview:_dragHandle];
    [self layoutPaneDragHandle];

    // The drop preview is a single composited layer. Updating its
    // frame during dragging avoids view-tree churn and never asks the
    // Metal terminal surface for a snapshot/readback.
    _dropIndicator = [CALayer layer];
    _dropIndicator.hidden = YES;
    _dropIndicator.zPosition = 1000;
    _dropIndicator.cornerRadius = 5.0;
    _dropIndicator.backgroundColor =
        [NSColor.controlAccentColor colorWithAlphaComponent:0.28].CGColor;
    [self.layer addSublayer:_dropIndicator];

    // Accept file drag-and-drop. Dropped paths are sent to the
    // surface as text (ghostty_surface_text) — typed at the prompt
    // as if the user pasted them. Matches Terminal.app behaviour.
    [self registerForDraggedTypes:@[GhosttyPanePasteboardType,
                                     NSPasteboardTypeFileURL,
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
    [nc removeObserver:self name:NSWindowDidResizeNotification object:nil];
    [nc removeObserver:self name:NSWindowDidEndLiveResizeNotification object:nil];
    [nc removeObserver:self name:NSWindowDidEnterFullScreenNotification object:nil];
    [nc removeObserver:self name:NSWindowDidExitFullScreenNotification object:nil];
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
        // ── Resize / fullscreen plumbing ─────────────────────────────
        // The tab container's autoresizingMask cascades window
        // resizes down to this view's `setFrameSize:` automatically,
        // so in the steady state ghostty sees every size change. The
        // problem cases are:
        //
        //   * macOS fullscreen transitions — the animation pass
        //     mutates `contentLayoutRect` in a different runloop
        //     iteration than the frame change, so the
        //     `[self ghosttySafeSize]` reading inside the cascaded
        //     `setFrameSize:` is stale (top rows render under the
        //     hidden menu bar / under the notch).
        //   * External window managers (Magnet / Rectangle / system
        //     fullscreen-tile) sometimes resize the window with the
        //     WKWebView layout already settled, leaving ghostty
        //     stuck on the pre-resize size when the React side's
        //     ResizeObserver doesn't observe a meaningful enough
        //     change to fire.
        //
        // Subscribing to these four notifications and re-syncing
        // size + chrome-inset reframe in each handler covers both
        // cases. The notifications fire AFTER macOS has settled the
        // post-resize geometry, so `contentLayoutRect` is correct
        // by the time our handler runs.
        [nc addObserver:self
               selector:@selector(windowDidResizeOrEndFullScreen:)
                   name:NSWindowDidResizeNotification
                 object:self.window];
        [nc addObserver:self
               selector:@selector(windowDidResizeOrEndFullScreen:)
                   name:NSWindowDidEndLiveResizeNotification
                 object:self.window];
        [nc addObserver:self
               selector:@selector(windowDidResizeOrEndFullScreen:)
                   name:NSWindowDidEnterFullScreenNotification
                 object:self.window];
        [nc addObserver:self
               selector:@selector(windowDidResizeOrEndFullScreen:)
                   name:NSWindowDidExitFullScreenNotification
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

/// Handler for `NSWindowDidResizeNotification`,
/// `NSWindowDidEndLiveResizeNotification`,
/// `NSWindowDidEnterFullScreenNotification` and
/// `NSWindowDidExitFullScreenNotification`.
///
/// Forces a re-application of the cached chrome inset (so the tab
/// container is reframed against the now-current `contentView.bounds`)
/// and a fresh `ghostty_surface_set_size` against the post-transition
/// safe size. Both are needed because the autoresizing cascade alone
/// uses whatever `contentLayoutRect` was at the time of the cascaded
/// `setFrameSize:`, which during fullscreen transitions can lag the
/// actual window geometry by one runloop tick.
///
/// Dispatched onto the next main-queue tick rather than running
/// inline so the handler observes the FINAL post-notification state
/// — AppKit posts these notifications mid-transaction in some cases
/// and `contentLayoutRect` only converges after the current call
/// stack unwinds.
- (void)windowDidResizeOrEndFullScreen:(NSNotification *)note {
    // Every pane observes the same window notification. Coalesce them
    // into one tree walk on the next runloop tick; without this, N panes
    // each resynced all N surfaces (O(N²)) during live resize.
    if (g_window_resync_scheduled) return;
    g_window_resync_scheduled = YES;
    dispatch_async(dispatch_get_main_queue(), ^{
        g_window_resync_scheduled = NO;
        [self resyncSizeFromWindow];
    });
}

/// Re-apply the cached chrome inset (reframes the tab container
/// against the current contentView bounds) and push a fresh size to
/// every live ghostty surface in the tree. Called from the resize /
/// fullscreen notification handlers above; thin wrapper around
/// `resync_chrome_and_surfaces` which has visibility into the
/// static globals.
- (void)resyncSizeFromWindow {
    if (!self.window) return;
    resync_chrome_and_surfaces(self);
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

- (NSString *)dragIdentifier { return _dragIdentifier; }

- (void)layoutPaneDragHandle {
    static const CGFloat width = 80.0;
    static const CGFloat height = 14.0;
    _dragHandle.frame = NSMakeRect(MAX(0, (self.bounds.size.width - width) * 0.5),
                                   0, MIN(width, self.bounds.size.width), height);
}

- (void)setPaneDragHandleVisible:(BOOL)visible {
    if (_dragHandle.dragging) visible = YES;
    _dragHandle.hidden = !visible;
}

- (NSButton *)nativeSearchButtonWithTitle:(NSString *)title
                                    action:(SEL)action
                        accessibilityLabel:(NSString *)label {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.bordered = NO;
    button.font = [NSFont systemFontOfSize:14 weight:NSFontWeightMedium];
    button.contentTintColor = NSColor.secondaryLabelColor;
    button.toolTip = label;
    button.accessibilityLabel = label;
    return button;
}

- (void)ensureNativeSearchOverlay {
    if (_searchOverlay) return;

    _searchOverlay = [[NSView alloc] initWithFrame:NSZeroRect];
    _searchOverlay.wantsLayer = YES;
    _searchOverlay.layer.backgroundColor =
        [NSColor.windowBackgroundColor colorWithAlphaComponent:0.96].CGColor;
    _searchOverlay.layer.cornerRadius = 9.0;
    _searchOverlay.layer.shadowColor = NSColor.blackColor.CGColor;
    _searchOverlay.layer.shadowOpacity = 0.28;
    _searchOverlay.layer.shadowRadius = 5.0;
    _searchOverlay.layer.shadowOffset = NSMakeSize(0, -2);
    _searchOverlay.hidden = YES;

    _searchField = [[NSSearchField alloc] initWithFrame:NSZeroRect];
    _searchField.placeholderString = @"Search scrollback";
    _searchField.delegate = self;
    _searchField.controlSize = NSControlSizeSmall;
    _searchField.accessibilityLabel = @"Search terminal scrollback";
    [_searchOverlay addSubview:_searchField];

    _searchCount = [NSTextField labelWithString:@"…"];
    _searchCount.alignment = NSTextAlignmentRight;
    _searchCount.font = [NSFont monospacedDigitSystemFontOfSize:11
                                                       weight:NSFontWeightRegular];
    _searchCount.textColor = NSColor.secondaryLabelColor;
    _searchCount.accessibilityLabel = @"Search result count";
    [_searchOverlay addSubview:_searchCount];

    _searchPreviousButton = [self nativeSearchButtonWithTitle:@"↑"
                                                       action:@selector(nativeSearchNext:)
                                           accessibilityLabel:@"Next match above"];
    _searchNextButton = [self nativeSearchButtonWithTitle:@"↓"
                                                   action:@selector(nativeSearchPrevious:)
                                       accessibilityLabel:@"Previous match below"];
    _searchCloseButton = [self nativeSearchButtonWithTitle:@"×"
                                                    action:@selector(nativeSearchClose:)
                                        accessibilityLabel:@"Close search"];
    [_searchOverlay addSubview:_searchPreviousButton];
    [_searchOverlay addSubview:_searchNextButton];
    [_searchOverlay addSubview:_searchCloseButton];

    [self addSubview:_searchOverlay positioned:NSWindowAbove relativeTo:nil];
}

- (void)layoutNativeSearchOverlay {
    if (!_searchOverlay) return;
    CGFloat width = MIN(360.0, MAX(0.0, self.bounds.size.width - 16.0));
    CGFloat height = 42.0;
    _searchOverlay.frame = NSMakeRect(MAX(8.0, self.bounds.size.width - width - 8.0),
                                      8.0, width, height);
    CGFloat buttonWidth = 24.0;
    BOOL showNavigation = width >= 220.0;
    BOOL showCount = width >= 285.0;
    _searchPreviousButton.hidden = !showNavigation;
    _searchNextButton.hidden = !showNavigation;
    _searchCount.hidden = !showCount;
    CGFloat padding = width >= 80.0 ? 8.0 : 3.0;
    CGFloat countWidth = showCount ? 46.0 : 0.0;
    CGFloat navigationWidth = showNavigation ? buttonWidth * 2.0 : 0.0;
    CGFloat fieldWidth = MAX(1.0, width - padding * 2.0 - countWidth -
                             navigationWidth - buttonWidth - 4.0);
    _searchField.frame = NSMakeRect(padding, 8.0, fieldWidth, 26.0);
    CGFloat x = NSMaxX(_searchField.frame) + 2.0;
    if (showCount) {
        _searchCount.frame = NSMakeRect(x, 11.0, countWidth, 20.0);
        x += countWidth + 2.0;
    }
    if (showNavigation) {
        _searchPreviousButton.frame = NSMakeRect(x, 9.0, buttonWidth, 24.0);
        x += buttonWidth;
        _searchNextButton.frame = NSMakeRect(x, 9.0, buttonWidth, 24.0);
        x += buttonWidth;
    }
    _searchCloseButton.frame = NSMakeRect(MIN(x, MAX(0.0, width - padding - buttonWidth)),
                                          9.0, buttonWidth, 24.0);
}

- (BOOL)performSearchBinding:(NSString *)binding {
    if (!_surface || !binding.length) return NO;
    const char *utf8 = binding.UTF8String;
    if (!utf8) return NO;
    return ghostty_surface_binding_action(_surface, utf8, strlen(utf8));
}

- (void)updateNativeSearchCountLabel {
    if (!_searchCount) return;
    if (_searchTotal < 0) {
        _searchCount.stringValue = @"…";
    } else if (_searchTotal == 0) {
        _searchCount.stringValue = @"0/0";
    } else if (_searchSelected >= 0) {
        _searchCount.stringValue = [NSString stringWithFormat:@"%ld/%ld",
            (long)(_searchSelected + 1), (long)_searchTotal];
    } else {
        _searchCount.stringValue = [NSString stringWithFormat:@"0/%ld",
            (long)_searchTotal];
    }
    NSAccessibilityPostNotification(_searchCount,
                                    NSAccessibilityValueChangedNotification);
}

- (void)beginNativeSearchWithNeedle:(NSString *)needle {
    [self ensureNativeSearchOverlay];
    BOOL wasVisible = !_searchOverlay.hidden;
    BOOL focusOnly = wasVisible && needle.length == 0;
    // A focus-only repeat must not cancel the in-flight query debounce.
    // Its generation remains valid so the pending text is still sent.
    if (!focusOnly) _searchGeneration += 1;
    // A second Cmd+F focuses the existing query. A non-empty needle
    // (search_selection) replaces it and must be forwarded because
    // start_search itself only asks the embedding UI to open.
    if (needle.length > 0 || !wasVisible) {
        _searchQueryPending = NO;
        _searchTotal = -1;
        _searchSelected = -1;
        _searchField.stringValue = needle ?: @"";
    }
    [self updateNativeSearchCountLabel];
    [self layoutNativeSearchOverlay];
    _searchOverlay.hidden = NO;
    [self addSubview:_searchOverlay positioned:NSWindowAbove relativeTo:nil];
    NSUInteger focusGeneration = _searchGeneration;
    NSResponder *focusSource = self.window.firstResponder;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSView *tabRoot = tab_root_for_descendant(self);
        if (self->_searchOverlay.hidden || !self.window ||
            self->_searchGeneration != focusGeneration || !tabRoot ||
            tabRoot.hidden || (self.window.firstResponder != self &&
                               ![self nativeSearchOwnsFocus] &&
                               self.window.firstResponder != focusSource)) return;
        [self.window makeFirstResponder:self->_searchField];
        [self->_searchField selectText:nil];
    });
    if (needle.length > 0) {
        [self performSearchBinding:[@"search:" stringByAppendingString:needle]];
    }
}

- (void)endNativeSearch {
    if (!_searchOverlay) return;
    _searchGeneration += 1;
    _searchQueryPending = NO;
    BOOL ownedFocus = _searchField.currentEditor == self.window.firstResponder;
    _searchOverlay.hidden = YES;
    if (ownedFocus && ![tab_root_for_descendant(self) isHidden]) {
        [self.window makeFirstResponder:self];
    }
}

- (BOOL)nativeSearchOwnsFocus {
    return _searchField && _searchField.currentEditor == self.window.firstResponder;
}

- (void)updateNativeSearchTotal:(NSInteger)total {
    if (_searchQueryPending) return;
    _searchTotal = MAX(-1, total);
    [self updateNativeSearchCountLabel];
}

- (void)updateNativeSearchSelected:(NSInteger)selected {
    if (_searchQueryPending) return;
    _searchSelected = MAX(-1, selected);
    [self updateNativeSearchCountLabel];
}

- (void)nativeSearchPrevious:(id)sender {
    [self performSearchBinding:@"navigate_search:previous"];
}

- (void)nativeSearchNext:(id)sender {
    [self performSearchBinding:@"navigate_search:next"];
}

- (void)nativeSearchClose:(id)sender {
    [self performSearchBinding:@"end_search"];
}

- (void)controlTextDidChange:(NSNotification *)notification {
    if (notification.object != _searchField || _searchOverlay.hidden) return;
    NSString *query = [_searchField.stringValue copy];
    NSUInteger generation = ++_searchGeneration;
    _searchQueryPending = YES;
    _searchTotal = -1;
    _searchSelected = -1;
    [self updateNativeSearchCountLabel];
    __weak GhosttyHostView *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        GhosttyHostView *strongSelf = weakSelf;
        if (!strongSelf || strongSelf->_searchOverlay.hidden ||
            strongSelf->_searchGeneration != generation) return;
        strongSelf->_searchQueryPending = NO;
        [strongSelf performSearchBinding:[@"search:" stringByAppendingString:query]];
    });
}

- (BOOL)control:(NSControl *)control
        textView:(NSTextView *)textView
doCommandBySelector:(SEL)commandSelector {
    if (control != _searchField) return NO;
    if (commandSelector == @selector(cancelOperation:)) {
        if (_searchField.stringValue.length == 0) {
            [self nativeSearchClose:nil];
        } else if (self.window) {
            [self.window makeFirstResponder:self];
        }
        return YES;
    }
    if (commandSelector == @selector(insertNewline:) ||
        commandSelector == @selector(insertNewlineIgnoringFieldEditor:)) {
        BOOL previous = (NSApp.currentEvent.modifierFlags & NSEventModifierFlagShift) != 0;
        previous ? [self nativeSearchPrevious:nil] : [self nativeSearchNext:nil];
        return YES;
    }
    return NO;
}

- (GhosttyPaneDropZone)paneDropZoneForDraggingInfo:(id<NSDraggingInfo>)sender {
    NSPoint p = [self convertPoint:sender.draggingLocation fromView:nil];
    CGFloat w = self.bounds.size.width;
    CGFloat h = self.bounds.size.height;
    if (w <= 0 || h <= 0) return GhosttyPaneDropZoneNone;
    CGFloat left = p.x / w;
    CGFloat right = 1.0 - left;
    CGFloat top = p.y / h; // GhosttyHostView is flipped: y=0 is top.
    CGFloat bottom = 1.0 - top;
    CGFloat nearest = MIN(MIN(left, right), MIN(top, bottom));
    if (nearest == left) return GhosttyPaneDropZoneLeft;
    if (nearest == right) return GhosttyPaneDropZoneRight;
    if (nearest == top) return GhosttyPaneDropZoneTop;
    return GhosttyPaneDropZoneBottom;
}

- (void)showPaneDropZone:(GhosttyPaneDropZone)zone {
    if (zone == GhosttyPaneDropZoneNone) {
        _dropIndicator.hidden = YES;
        _shownDropZone = GhosttyPaneDropZoneNone;
        return;
    }
    NSRect r = self.bounds;
    switch (zone) {
        case GhosttyPaneDropZoneTop:    r.size.height *= 0.5; break;
        case GhosttyPaneDropZoneBottom: r.origin.y += r.size.height * 0.5;
                                         r.size.height *= 0.5; break;
        case GhosttyPaneDropZoneLeft:   r.size.width *= 0.5; break;
        case GhosttyPaneDropZoneRight:  r.origin.x += r.size.width * 0.5;
                                         r.size.width *= 0.5; break;
        default: break;
    }
    // NSView coordinates are flipped, while Ghostty's custom root
    // IOSurface CALayer may use Core Animation's bottom-left origin.
    // Convert only when the installed renderer layer isn't flipped.
    if (!_dropIndicator.superlayer.geometryFlipped) {
        r.origin.y = self.bounds.size.height - NSMaxY(r);
    }
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    _dropIndicator.frame = r;
    _dropIndicator.hidden = NO;
    _shownDropZone = zone;
    [CATransaction commit];
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
    NSPasteboard *pb = sender.draggingPasteboard;
    if ([pb availableTypeFromArray:@[GhosttyPanePasteboardType]]) {
        NSString *identifier = [pb stringForType:GhosttyPanePasteboardType];
        GhosttyHostView *source = host_for_drag_identifier(identifier);
        if (!source || source == self ||
            tab_root_for_descendant(source) != tab_root_for_descendant(self)) {
            [self showPaneDropZone:GhosttyPaneDropZoneNone];
            return NSDragOperationNone;
        }
        [self showPaneDropZone:[self paneDropZoneForDraggingInfo:sender]];
        return NSDragOperationMove;
    }
    if (![pb availableTypeFromArray:@[NSPasteboardTypeFileURL,
                                      NSPasteboardTypeString]]) {
        return NSDragOperationNone;
    }
    return NSDragOperationCopy;
}

- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)sender {
    NSPasteboard *pb = sender.draggingPasteboard;
    if (![pb availableTypeFromArray:@[GhosttyPanePasteboardType]]) {
        return [pb availableTypeFromArray:@[NSPasteboardTypeFileURL,
                                             NSPasteboardTypeString]]
            ? NSDragOperationCopy : NSDragOperationNone;
    }
    NSString *identifier = [pb stringForType:GhosttyPanePasteboardType];
    GhosttyHostView *source = host_for_drag_identifier(identifier);
    if (!source || source == self ||
        tab_root_for_descendant(source) != tab_root_for_descendant(self)) {
        [self showPaneDropZone:GhosttyPaneDropZoneNone];
        return NSDragOperationNone;
    }
    [self showPaneDropZone:[self paneDropZoneForDraggingInfo:sender]];
    return NSDragOperationMove;
}

- (void)draggingExited:(nullable id<NSDraggingInfo>)sender {
    [self showPaneDropZone:GhosttyPaneDropZoneNone];
}

- (BOOL)prepareForDragOperation:(id<NSDraggingInfo>)sender {
    return [sender.draggingPasteboard
        availableTypeFromArray:@[GhosttyPanePasteboardType,
                                 NSPasteboardTypeFileURL,
                                 NSPasteboardTypeString]] != nil;
}

- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    NSPasteboard *pb = sender.draggingPasteboard;

    if ([pb availableTypeFromArray:@[GhosttyPanePasteboardType]]) {
        NSString *identifier = [pb stringForType:GhosttyPanePasteboardType];
        GhosttyHostView *source = host_for_drag_identifier(identifier);
        GhosttyPaneDropZone zone = [self paneDropZoneForDraggingInfo:sender];
        [self showPaneDropZone:GhosttyPaneDropZoneNone];
        if (!source || source == self || zone == GhosttyPaneDropZoneNone) return NO;
        return move_pane_to_drop_zone(source, self, zone);
    }

    if (!_surface) return NO;

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

- (void)concludeDragOperation:(nullable id<NSDraggingInfo>)sender {
    [self showPaneDropZone:GhosttyPaneDropZoneNone];
}

- (BOOL)wantsPeriodicDraggingUpdates { return NO; }

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
    // When there is no top-chrome inset (distraction-free / full-window
    // mode) the tab container fills the entire contentView height.  The
    // contentLayoutRect clip applied below would otherwise shave off
    // titleBarHeight points from the bottom of the reported surface,
    // producing a visible gap at the bottom of the window equal to the
    // title-bar height (~28 pt).  In DF mode the title bar and traffic
    // lights are explicitly hidden, so letting ghostty use every pixel
    // is correct — subtract/add those heights only when chrome is present.
    if (g_inset_top < 1.0) return bounds;
    NSRect cl = self.window.contentLayoutRect;
    // contentLayoutRect is in window-content coordinates. Clip our
    // bounds height to it so we never report area that's behind a
    // system bar.
    CGFloat h = MIN(bounds.height, cl.size.height);
    CGFloat w = MIN(bounds.width,  cl.size.width);
    return NSMakeSize(w, h);
}

- (void)setSurface:(ghostty_surface_t)surface {
    if (!surface && _surface) {
        _searchGeneration += 1;
        _searchOverlay.hidden = YES;
    }
    _surface = surface;
    if (_surface && _dropIndicator.superlayer != self.layer) {
        // ghostty_surface_new installs its IOSurface-backed Metal layer
        // as the view's new root layer. Anything attached during init
        // belongs to the discarded layer, so mount the overlay only
        // after the renderer has completed that replacement.
        [_dropIndicator removeFromSuperlayer];
        [self.layer addSublayer:_dropIndicator];
    }
    // Register this view globally so action_cb / close_surface_cb
    // can find the NSWindow. Cleared on shutdown via setSurface(NULL).
    if (surface) {
        GhosttyRegisterHostView((__bridge void *)self);
    } else {
        clear_host_view_if_matches((__bridge void *)self);
        clear_last_host_view_if_matches((__bridge void *)self);
    }
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
    if (r) {
        // Clear the global "focused host view" pointer if (and only if)
        // it still names self. Without this, the application-level
        // NSEvent monitor (see `GhosttyInstallEventMonitor`) keeps
        // routing every Cmd-modified keystroke to this surface even
        // after focus moved to the WKWebView (i.e. the user navigated
        // to a different tool tab). End result: Cmd+C / Cmd+V on
        // /database-explorer, /markdown, /http-runner etc. were
        // silently consumed by ghostty instead of acting on the
        // active webview. We only clear when the slot still names us
        // because `becomeFirstResponder` on a NEW pane runs BEFORE the
        // old pane's `resignFirstResponder` (AppKit's documented
        // ordering), and we mustn't stomp the new pane's registration.
        clear_host_view_if_matches((__bridge void *)self);
        if (_surface) {
            ghostty_surface_set_focus(_surface, false);
            // Force a redraw so the cursor flips from solid → hollow.
            ghostty_surface_refresh(_surface);
        }
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
    [self layoutPaneDragHandle];
    [self layoutNativeSearchOverlay];
    if (_shownDropZone != GhosttyPaneDropZoneNone) {
        [self showPaneDropZone:_shownDropZone];
    }
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
    emit_terminal_interaction_event(_surface);
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
    emit_terminal_interaction_event(_surface);
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
    emit_terminal_interaction_event(_surface);
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
    emit_terminal_interaction_event(_surface);
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
    NSPoint p = [self ghosttyMousePoint:event];
    CGFloat revealHeight = MIN(self.bounds.size.height,
                               MAX(14.0, self.bounds.size.height * 0.20));
    [self setPaneDragHandleVisible:(p.y >= 0 && p.y <= revealHeight)];
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
    emit_terminal_interaction_event(_surface);
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
    NSPoint p = [self ghosttyMousePoint:event];
    if (!NSPointInRect(p, self.bounds)) [self setPaneDragHandleVisible:NO];
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

static const void * const kSuppressDividerKey = &kSuppressDividerKey;

@implementation GhosttyPaneDragHandle

- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }

- (void)resetCursorRects {
    [self addCursorRect:self.bounds
                 cursor:self.dragging ? NSCursor.closedHandCursor
                                      : NSCursor.openHandCursor];
}

- (void)drawRect:(NSRect)dirtyRect {
    [super drawRect:dirtyRect];
    NSRect pill = NSInsetRect(self.bounds, 1.0, 2.0);
    [[NSColor.windowBackgroundColor colorWithAlphaComponent:0.86] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:pill xRadius:6 yRadius:6] fill];

    NSDictionary *attrs = @{
        NSFontAttributeName: [NSFont systemFontOfSize:9 weight:NSFontWeightSemibold],
        NSForegroundColorAttributeName:
            [NSColor.secondaryLabelColor colorWithAlphaComponent:0.9],
    };
    NSAttributedString *dots = [[NSAttributedString alloc] initWithString:@"•••"
                                                               attributes:attrs];
    NSSize size = dots.size;
    [dots drawAtPoint:NSMakePoint((self.bounds.size.width - size.width) * 0.5,
                                  (self.bounds.size.height - size.height) * 0.5 - 1.0)];
}

- (void)mouseDown:(NSEvent *)event {
    // Consume the press. Terminal selection must not start underneath
    // a pane drag, and the actual session begins only once AppKit sends
    // mouseDragged after crossing its normal drag threshold.
}

- (void)mouseDragged:(NSEvent *)event {
    if (self.dragging || !self.hostView) return;
    NSString *identifier = self.hostView.dragIdentifier;
    if (!identifier.length) return;

    NSPasteboardItem *pb = [[NSPasteboardItem alloc] init];
    [pb setString:identifier forType:GhosttyPanePasteboardType];
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:pb];

    // Use a tiny vector-like badge rather than reading the Metal layer
    // back into CPU memory. GPU snapshots are surprisingly expensive
    // on large retina panes and can stall the renderer at drag start.
    NSSize imageSize = NSMakeSize(132, 34);
    NSImage *image = [[NSImage alloc] initWithSize:imageSize];
    [image lockFocus];
    [[NSColor.windowBackgroundColor colorWithAlphaComponent:0.94] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(0, 0, imageSize.width,
                                                        imageSize.height)
                                     xRadius:8 yRadius:8] fill];
    NSDictionary *attrs = @{
        NSFontAttributeName: [NSFont systemFontOfSize:12 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: NSColor.labelColor,
    };
    [@"Move terminal pane" drawAtPoint:NSMakePoint(12, 9) withAttributes:attrs];
    [image unlockFocus];

    NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
    [item setDraggingFrame:NSMakeRect(p.x - imageSize.width * 0.5,
                                      p.y - imageSize.height * 0.5,
                                      imageSize.width, imageSize.height)
                 contents:image];

    self.dragging = YES;
    g_active_pane_drag_source = self.hostView;
    g_active_pane_drag_identifier = identifier;
    [self setNeedsDisplay:YES];
    NSDraggingSession *session = [self beginDraggingSessionWithItems:@[item]
                                                               event:event
                                                              source:self];
    session.animatesToStartingPositionsOnCancelOrFail = YES;
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    return context == NSDraggingContextWithinApplication
        ? NSDragOperationMove : NSDragOperationNone;
}

- (void)draggingSession:(NSDraggingSession *)session
                 endedAtPoint:(NSPoint)screenPoint
                 operation:(NSDragOperation)operation {
    self.dragging = NO;
    g_active_pane_drag_source = nil;
    g_active_pane_drag_identifier = nil;
    [self.hostView setPaneDragHandleVisible:NO];
    [self setNeedsDisplay:YES];
}

@end

@implementation GhosttySplitView

- (CGFloat)dividerThickness {
    NSNumber *suppressed = objc_getAssociatedObject(self, kSuppressDividerKey);
    if (suppressed.boolValue) return 0;
    return [super dividerThickness];
}

- (void)drawDividerInRect:(NSRect)rect {
    NSNumber *suppressed = objc_getAssociatedObject(self, kSuppressDividerKey);
    if (suppressed.boolValue) return;
    [super drawDividerInRect:rect];
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

void GhosttyDeferSurfaceFree(ghostty_surface_t surface) {
    if (!surface) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        ghostty_surface_free(surface);
    });
}

// ---- Action / close-surface dispatch ------------------------------------
//
// libghostty's action_cb fires for window-title updates, fullscreen
// toggles, ring bell, open URL, close window, mouse-shape changes,
// etc. We register the host NSView globally (single-window v1) so the
// handler can find the right NSWindow.

static _Atomic(void *) g_host_view = NULL;
static _Atomic(void *) g_last_host_view = NULL;
static _Atomic(void *) g_app = NULL;
static _Atomic(void *) g_search_surface = NULL;
static int tab_id_for_surface(ghostty_surface_t surface);

void GhosttyRegisterHostView(void *view) {
    atomic_store(&g_host_view, view);
    if (view) atomic_store(&g_last_host_view, view);
}

bool GhosttyFocusedSurfaceBindingAction(const char *action) {
    if (!action) return false;
    BOOL startingSearch = strcmp(action, "start_search") == 0;
    ghostty_surface_t surface = startingSearch ? NULL : atomic_load(&g_search_surface);
    // Never dereference a cached surface after its native view has gone
    // away. Pointer comparison while walking the live tree is safe.
    if (surface && tab_id_for_surface(surface) == 0) {
        atomic_store(&g_search_surface, NULL);
        surface = NULL;
    }
    if (!surface) {
        void *candidate = atomic_load(&g_host_view);
        if (!candidate && startingSearch) candidate = atomic_load(&g_last_host_view);
        NSView *view = (__bridge NSView *)candidate;
        if ([view isKindOfClass:[GhosttyHostView class]]) {
            NSView *tabRoot = tab_root_for_descendant(view);
            if (tabRoot && !tabRoot.hidden) {
                surface = [(GhosttyHostView *)view surface];
            }
        }
    }
    if (!surface && startingSearch) surface = active_tab_fallback_surface();
    if (!surface) return false;
    return ghostty_surface_binding_action(surface, action, strlen(action));
}

// Conditional clear used by `resignFirstResponder`. Declared at the top
// of the file (above @implementation) so the ObjC method body can call
// it; defined here because that's where `g_host_view` itself lives.
// The compare-and-clear shape is needed because AppKit fires the new
// responder's `becomeFirstResponder` BEFORE the old one's
// `resignFirstResponder`, so a blind clear would wipe out the new
// pane's registration mid-focus-swap.
static void clear_host_view_if_matches(void *expected) {
    void *current = atomic_load(&g_host_view);
    if (current == expected) {
        atomic_store(&g_host_view, NULL);
    }
}

static void clear_last_host_view_if_matches(void *expected) {
    if (atomic_load(&g_last_host_view) == expected) {
        atomic_store(&g_last_host_view, NULL);
    }
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

// Per-tab zoom bookkeeping. Stored on the tab-root view (the direct
// child of `g_tab_container`) so each tab can independently remember
// whether one of its split panes is temporarily expanded to fill the
// whole tab.
static const void * const kZoomedHostKey = &kZoomedHostKey;
static const void * const kZoomSnapshotKey = &kZoomSnapshotKey;

// Forward decl — `collect_hosts` is defined further down with the
// rest of the split-navigation helpers, but `GhosttyTabClose` (just
// below) needs it now to walk the closing subtree.
static void collect_hosts(NSView *root, NSMutableArray<GhosttyHostView *> *out);

// Forward declaration — defined in the split-navigation section below.
static GhosttyHostView *find_first_host_descendant(NSView *root);
static NSView *tab_root_for_descendant(NSView *view);
static BOOL tab_has_multiple_panes(NSView *tab_root);
static void restore_tab_zoom(NSView *tab_root);
static void clear_tab_zoom_for_descendant(NSView *view);
static BOOL toggle_tab_zoom_for_host(GhosttyHostView *target);
static void reapply_tab_zoom_if_needed(NSView *tab_root);

// Ghostty's occlusion API takes a "visible" boolean, not "occluded".
// Keep the tab-root hidden state and every descendant surface's render
// visibility in sync so background tabs stop behaving like visible
// render targets while their PTYs and scrollback stay alive.
static void set_tab_root_visible(NSView *root, BOOL visible) {
    if (!root) return;
    NSMutableArray<GhosttyHostView *> *hosts = [NSMutableArray array];
    collect_hosts(root, hosts);
    for (GhosttyHostView *host in hosts) {
        ghostty_surface_t s = [host surface];
        if (s) ghostty_surface_set_occlusion(s, visible);
    }
    root.hidden = !visible;
}

static int tab_id_get(NSView *v) {
    NSNumber *n = objc_getAssociatedObject(v, kTabIdKey);
    return n ? n.intValue : 0;
}
static void tab_id_set(NSView *v, int id_) {
    objc_setAssociatedObject(v, kTabIdKey, @(id_),
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
// HTML chrome insets in points. Updated via GhosttyTabContainerSetChromeInset.
// These are measured in the WKWebView's CSS/layout coordinate space.
static CGFloat g_inset_top = 0, g_inset_right = 0, g_inset_bottom = 0, g_inset_left = 0;
// Whole-app webview zoom (`webview.setZoom`). The NSView sibling is NOT
// scaled by WKWebView, so chrome insets must be multiplied by this factor
// when converting CSS rects → window points.
static CGFloat g_webview_content_zoom = 1.0;

// Tab event delivery — Rust installs a callback that emits Tauri events.
typedef void (*GhosttyTabEventFn)(int kind, int tab_id, const char *value);
// kind values map to TAB_EVENT_* below; kept in sync with macos.rs.
enum {
    TAB_EVENT_CREATED = 1,
    TAB_EVENT_FOCUSED = 2,
    TAB_EVENT_CLOSED  = 3,
    TAB_EVENT_TITLE   = 4,
    TAB_EVENT_PWD     = 5,
};
static GhosttyTabEventFn g_tab_event_fn = NULL;

void GhosttyRegisterTabEventCallback(GhosttyTabEventFn fn) {
    g_tab_event_fn = fn;
}

static void emit_tab_event(int kind, int tab_id, NSString *value) {
    if (!g_tab_event_fn) return;
    const char *v = value ? value.UTF8String : NULL;
    g_tab_event_fn(kind, tab_id, v);
}

// Terminal-native status event delivery — Rust installs a callback that
// normalises the per-tab payload into a single Tauri event stream the
// frontend can mirror in the workspace rail.
typedef void (*GhosttyTerminalStatusEventFn)(
    int kind,
    int tab_id,
    long long arg0,
    long long arg1,
    const char *text0,
    const char *text1);
// kind values map to TERMINAL_STATUS_EVENT_* below; kept in sync with
// `TerminalStatusEventKind` in macos.rs.
enum {
    TERMINAL_STATUS_EVENT_PROGRESS             = 1,
    TERMINAL_STATUS_EVENT_COMMAND_FINISHED    = 2,
    TERMINAL_STATUS_EVENT_BELL                = 3,
    TERMINAL_STATUS_EVENT_INTERACTION         = 4,
    TERMINAL_STATUS_EVENT_DESKTOP_NOTIFICATION = 5,
    TERMINAL_STATUS_EVENT_CHILD_EXITED        = 6,
    TERMINAL_STATUS_EVENT_RENDERER_HEALTH     = 7,
    TERMINAL_STATUS_EVENT_SEARCH_STARTED      = 8,
    TERMINAL_STATUS_EVENT_SEARCH_ENDED        = 9,
    TERMINAL_STATUS_EVENT_SEARCH_TOTAL        = 10,
    TERMINAL_STATUS_EVENT_SEARCH_SELECTED     = 11,
};
static GhosttyTerminalStatusEventFn g_terminal_status_event_fn = NULL;

void GhosttyRegisterTerminalStatusEventCallback(GhosttyTerminalStatusEventFn fn) {
    g_terminal_status_event_fn = fn;
}

static long long saturating_u64_to_i64(uint64_t value) {
    return value > (uint64_t)LLONG_MAX ? LLONG_MAX : (long long)value;
}

static void emit_terminal_status_event(
    int kind,
    int tab_id,
    long long arg0,
    long long arg1,
    NSString *text0,
    NSString *text1
) {
    if (!g_terminal_status_event_fn) return;
    const char *v0 = text0 ? text0.UTF8String : NULL;
    const char *v1 = text1 ? text1.UTF8String : NULL;
    g_terminal_status_event_fn(kind, tab_id, arg0, arg1, v0, v1);
}

static void emit_terminal_interaction_event(ghostty_surface_t surface) {
    int tab_id = tab_id_for_surface(surface);
    if (tab_id <= 0) return;
    emit_terminal_status_event(
        TERMINAL_STATUS_EVENT_INTERACTION,
        tab_id,
        0,
        0,
        nil,
        nil);
}

static int tab_id_for_surface(ghostty_surface_t surface) {
    if (!surface || !g_tab_container) return 0;
    for (NSView *child in g_tab_container.subviews) {
        GhosttyHostView *match = nil;
        NSMutableArray<NSView *> *stack = [@[child] mutableCopy];
        while (stack.count > 0) {
            NSView *cur = stack.lastObject;
            [stack removeLastObject];
            if ([cur isKindOfClass:[GhosttyHostView class]]
                && [(GhosttyHostView *)cur surface] == surface) {
                match = (GhosttyHostView *)cur;
                break;
            }
            for (NSView *sub in cur.subviews) [stack addObject:sub];
        }
        if (match) return tab_id_get(child);
    }
    return 0;
}

static GhosttyHostView *host_view_for_surface(ghostty_surface_t surface) {
    if (!surface || !g_tab_container) return nil;
    NSMutableArray<NSView *> *stack = [g_tab_container.subviews mutableCopy];
    while (stack.count > 0) {
        NSView *view = stack.lastObject;
        [stack removeLastObject];
        if ([view isKindOfClass:[GhosttyHostView class]]
            && [(GhosttyHostView *)view surface] == surface) {
            return (GhosttyHostView *)view;
        }
        for (NSView *subview in view.subviews) [stack addObject:subview];
    }
    return nil;
}

static int tab_id_for_target(ghostty_target_s *tgt) {
    if (!tgt || tgt->tag != GHOSTTY_TARGET_SURFACE) return 0;
    return tab_id_for_surface(tgt->target.surface);
}

static int status_tab_id_for_target(ghostty_target_s *tgt) {
    int tab_id = tab_id_for_target(tgt);
    if (tab_id != 0) return tab_id;
    return GhosttyTabActiveId();
}

static NSView *root_for_tab_id(int tab_id) {
    if (!g_tab_container) return nil;
    for (NSView *child in g_tab_container.subviews) {
        if (tab_id_get(child) == tab_id) return child;
    }
    return nil;
}

static NSView *tab_root_for_descendant(NSView *view) {
    if (!g_tab_container || !view) return nil;
    NSView *walker = view;
    while (walker && walker.superview != g_tab_container) {
        walker = walker.superview;
    }
    return walker;
}

static BOOL tab_has_multiple_panes(NSView *tab_root) {
    if (!tab_root) return NO;
    NSMutableArray<GhosttyHostView *> *hosts = [NSMutableArray array];
    collect_hosts(tab_root, hosts);
    return hosts.count > 1;
}

// Compute the tab-container frame given the host contentView bounds and
// the current insets.
static NSRect tab_container_frame_in(NSView *contentView) {
    NSRect b = contentView.bounds;
    CGFloat z = g_webview_content_zoom;
    if (z <= 0) z = 1.0;
    CGFloat left = g_inset_left * z;
    CGFloat right = g_inset_right * z;
    CGFloat top = g_inset_top * z;
    CGFloat bottom = g_inset_bottom * z;
    return NSMakeRect(left,
                      bottom,
                      MAX(0, b.size.width  - left - right),
                      MAX(0, b.size.height - top  - bottom));
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

void GhosttyTabContainerSetWebviewContentZoom(double zoom) {
    if (zoom <= 0) zoom = 1.0;
    g_webview_content_zoom = (CGFloat)zoom;
    if (!g_tab_container) return;
    NSView *parent = g_tab_container.superview;
    if (!parent) return;
    g_tab_container.frame = tab_container_frame_in(parent);
    // Re-push surface sizes — the container just changed geometry.
    GhosttyHostView *any = nil;
    for (NSView *tab_root in g_tab_container.subviews) {
        any = find_first_host_descendant(tab_root);
        if (any) break;
    }
    if (any) resync_chrome_and_surfaces(any);
}

// Resize-handler back end. Implements the work for
// `-[GhosttyHostView resyncSizeFromWindow]`; defined here because
// it needs visibility into the file-scope `g_tab_container` and
// `g_inset_*` statics. Called from the window-resize notification
// path so a fullscreen entry/exit (or a Magnet-style snap) reflows
// the tab container and re-pushes size+scale to every live
// ghostty_surface in the tree — not just the host view that
// happened to receive the AppKit notification.
//
// The autoresizing cascade alone is insufficient because macOS
// fires `NSWindowDidEnterFullScreenNotification` AFTER it has
// finished mutating the window geometry, but during the transition
// the cascaded `setFrameSize:` reads `contentLayoutRect` which can
// still be one runloop tick stale. This second pass guarantees a
// final, correct size lands on ghostty.
static void resync_chrome_and_surfaces(GhosttyHostView *fallback) {
    NSWindow *window = fallback ? fallback.window : nil;
    if (!window) return;

    // Re-apply the cached chrome inset. With the contentView's new
    // bounds, this snaps the tab container to the right rect even
    // when the autoresizing cascade ran with stale geometry.
    GhosttyTabContainerSetChromeInset((double)g_inset_top,
                                      (double)g_inset_right,
                                      (double)g_inset_bottom,
                                      (double)g_inset_left);

    CGFloat scale = window.backingScaleFactor;
    if (scale <= 0) scale = 1.0;

    // No tab container yet — happens for the very first surface
    // before `terminal_new` has run end-to-end. Just sync the
    // fallback host view in that case.
    if (!g_tab_container) {
        ghostty_surface_t s = [fallback surface];
        if (!s) return;
        NSSize safe = [fallback ghosttySafeSize];
        ghostty_surface_set_content_scale(s, (double)scale, (double)scale);
        ghostty_surface_set_size(s,
                                 (uint32_t)(safe.width  * scale),
                                 (uint32_t)(safe.height * scale));
        return;
    }

    // Walk the tree and re-sync every live host view (includes
    // split-spawned views the Rust side doesn't track).
    NSMutableArray<GhosttyHostView *> *all = [NSMutableArray array];
    for (NSView *tab_root in g_tab_container.subviews) {
        reapply_tab_zoom_if_needed(tab_root);
    }
    collect_hosts(g_tab_container, all);
    for (GhosttyHostView *host in all) {
        ghostty_surface_t s = [host surface];
        if (!s) continue;
        NSSize safe = [host ghosttySafeSize];
        ghostty_surface_set_content_scale(s, (double)scale, (double)scale);
        ghostty_surface_set_size(s,
                                 (uint32_t)(safe.width  * scale),
                                 (uint32_t)(safe.height * scale));
    }
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
    for (NSView *child in g_tab_container.subviews) set_tab_root_visible(child, NO);
    set_tab_root_visible(root, YES);
    [g_tab_container addSubview:root];
    emit_tab_event(TAB_EVENT_CREATED, id_, nil);
    emit_tab_event(TAB_EVENT_FOCUSED, id_, nil);
    return id_;
}

// Switch the active tab. Returns YES if found.
BOOL GhosttyTabFocus(int tab_id) {
    NSView *target = root_for_tab_id(tab_id);
    if (!target) return NO;
    for (NSView *child in g_tab_container.subviews) {
        set_tab_root_visible(child, child == target);
    }
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
        for (NSView *child in remaining) {
            set_tab_root_visible(child, child == neighbour);
        }
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

static ghostty_surface_t active_tab_fallback_surface(void) {
    if (!g_tab_container) return NULL;
    for (NSView *tabRoot in g_tab_container.subviews) {
        if (tabRoot.hidden) continue;
        return find_first_host_descendant(tabRoot).surface;
    }
    return NULL;
}

// Walk every GhosttyHostView under the tab container and call
// ghostty_surface_set_color_scheme on each one's surface. Used by
// the React `terminal_set_color_scheme` Tauri command to push a
// theme change into all live panes — including split-created
// surfaces that aren't tracked in the Rust `PluginState.surfaces`
// map (those are allocated directly in `perform_new_split` above
// without round-tripping through Rust).
//
// `dark` is `bool` (BOOL on ObjC) → maps to ghostty's color-scheme
// enum (LIGHT=0, DARK=1) which matches `ghostty_color_scheme_e`.
//
// Safe to call when no tabs exist; iterates nothing and returns 0.
// Returns the count of surfaces touched, useful for diagnostics.
int GhosttySetColorSchemeAll(int dark) {
    if (!g_tab_container) return 0;
    NSMutableArray<GhosttyHostView *> *all = [NSMutableArray array];
    collect_hosts(g_tab_container, all);
    int n = 0;
    for (GhosttyHostView *pane in all) {
        ghostty_surface_t s = pane.surface;
        if (!s) continue;
        ghostty_surface_set_color_scheme(s, (ghostty_color_scheme_e)dark);
        n += 1;
    }
    return n;
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

static void collect_splits(NSView *root, NSMutableArray<NSSplitView *> *out) {
    if ([root isKindOfClass:[NSSplitView class]]) {
        [out addObject:(NSSplitView *)root];
    }
    for (NSView *sub in root.subviews) collect_splits(sub, out);
}

// Replace a node without changing its slot in the parent. This is the
// fundamental split-tree mutation: remove+addSubview appends, which was
// the cause of panes (and sometimes whole tab roots) jumping to the end
// whenever a cross-axis split was created or collapsed.
static BOOL replace_view_preserving_position(NSView *oldView, NSView *newView) {
    NSView *parent = oldView.superview;
    if (!parent || !newView) return NO;

    NSRect frame = oldView.frame;
    NSAutoresizingMaskOptions mask = oldView.autoresizingMask;
    BOOL hidden = oldView.hidden;
    int rootTabId = parent == g_tab_container ? tab_id_get(oldView) : 0;
    NSSplitView *splitParent = nil;
    NSMutableArray<NSNumber *> *dividerRatios = nil;

    if ([parent isKindOfClass:[NSSplitView class]]) {
        splitParent = (NSSplitView *)parent;
        NSInteger idx = [splitParent.arrangedSubviews indexOfObject:oldView];
        if (idx == NSNotFound) return NO;
        CGFloat axis = splitParent.isVertical ? splitParent.bounds.size.width
                                              : splitParent.bounds.size.height;
        dividerRatios = [NSMutableArray array];
        for (NSInteger i = 0;
             i < (NSInteger)splitParent.arrangedSubviews.count - 1; i++) {
            NSView *child = splitParent.arrangedSubviews[i];
            CGFloat position = splitParent.isVertical
                ? NSMaxX(child.frame) : NSMaxY(child.frame);
            [dividerRatios addObject:@(axis > 0 ? position / axis : 0)];
        }
        [oldView removeFromSuperview];
        [splitParent insertArrangedSubview:newView atIndex:idx];
    } else {
        [parent replaceSubview:oldView with:newView];
    }

    newView.frame = frame;
    newView.autoresizingMask = mask;
    newView.hidden = hidden;
    if (rootTabId) tab_id_set(newView, rootTabId);
    if (splitParent) {
        [splitParent adjustSubviews];
        CGFloat axis = splitParent.isVertical ? splitParent.bounds.size.width
                                              : splitParent.bounds.size.height;
        for (NSInteger i = 0; i < (NSInteger)dividerRatios.count; i++) {
            [splitParent setPosition:axis * dividerRatios[i].doubleValue
                    ofDividerAtIndex:i];
        }
    }
    return YES;
}

static NSSplitView *wrap_leaf_with_binary_split(
    GhosttyHostView *destination,
    GhosttyHostView *inserted,
    BOOL vertical,
    BOOL insertAfter
) {
    if (!destination || !inserted || !destination.superview) return nil;
    GhosttySplitView *split = [[GhosttySplitView alloc] initWithFrame:destination.frame];
    split.vertical = vertical;
    split.dividerStyle = NSSplitViewDividerStyleThin;
    split.autoresizingMask = destination.autoresizingMask;

    if (!replace_view_preserving_position(destination, split)) return nil;
    if (insertAfter) {
        [split addArrangedSubview:destination];
        [split addArrangedSubview:inserted];
    } else {
        [split addArrangedSubview:inserted];
        [split addArrangedSubview:destination];
    }
    [split adjustSubviews];
    CGFloat axis = split.isVertical ? split.bounds.size.width : split.bounds.size.height;
    [split setPosition:axis * 0.5 ofDividerAtIndex:0];
    return split;
}

// Normalize after removing a leaf. Existing trees may contain n-ary
// splits from older builds, so only collapse 0/1-child nodes; 2+ child
// geometry and ordering remain untouched.
static void collapse_split_after_removal(NSSplitView *split) {
    NSSplitView *current = split;
    while (current) {
        NSArray<NSView *> *children = current.arrangedSubviews;
        NSView *parent = current.superview;
        if (children.count >= 2) {
            [current adjustSubviews];
            return;
        }
        if (children.count == 1) {
            NSView *only = children.firstObject;
            [only removeFromSuperview];
            if (!replace_view_preserving_position(current, only)) return;
            current = [parent isKindOfClass:[NSSplitView class]]
                ? (NSSplitView *)parent : nil;
            continue;
        }
        [current removeFromSuperview];
        current = [parent isKindOfClass:[NSSplitView class]]
            ? (NSSplitView *)parent : nil;
    }
}

static GhosttyHostView *host_for_drag_identifier(NSString *identifier) {
    if (!identifier.length || !g_tab_container) return nil;
    GhosttyHostView *host = g_active_pane_drag_source;
    if (!host || ![g_active_pane_drag_identifier isEqualToString:identifier]) return nil;
    return tab_root_for_descendant(host) ? host : nil;
}

static BOOL move_pane_to_drop_zone(GhosttyHostView *source,
                                   GhosttyHostView *destination,
                                   GhosttyPaneDropZone zone) {
    if (!source || !destination || source == destination) return NO;
    NSView *sourceRoot = tab_root_for_descendant(source);
    NSView *destinationRoot = tab_root_for_descendant(destination);
    // v1 deliberately limits moves to the current tab. Cross-tab moves
    // need coordination with the HTML tab strip and session snapshot.
    if (!sourceRoot || sourceRoot != destinationRoot || sourceRoot.hidden) return NO;
    if (host_for_drag_identifier(source.dragIdentifier) != source) return NO;

    clear_tab_zoom_for_descendant(source);
    clear_tab_zoom_for_descendant(destination);

    NSSplitView *oldParent = [source.superview isKindOfClass:[NSSplitView class]]
        ? (NSSplitView *)source.superview : nil;
    if (!oldParent || oldParent.arrangedSubviews.count < 2) return NO;

    // Keep the exact live host/surface. No process, scrollback, or renderer
    // state is recreated during a pane move. Wrap the destination first;
    // adding source to the new split atomically reparents it from oldParent.
    // This ordering means a failed destination replacement leaves source
    // completely untouched rather than orphaning a running terminal.
    BOOL vertical = zone == GhosttyPaneDropZoneLeft ||
                    zone == GhosttyPaneDropZoneRight;
    BOOL after = zone == GhosttyPaneDropZoneRight ||
                 zone == GhosttyPaneDropZoneBottom;
    NSSplitView *newParent = wrap_leaf_with_binary_split(destination, source,
                                                          vertical, after);
    if (!newParent) {
        NSLog(@"[ghostty] pane drop could not wrap destination: source=%@ destination=%@",
              source, destination);
        return NO;
    }
    collapse_split_after_removal(oldParent);
    [source.window makeFirstResponder:source];
    resync_chrome_and_surfaces(source);
    return YES;
}

static void sync_surface_visibility_from_hidden(NSView *root, BOOL visible) {
    if (!root) return;
    BOOL selfVisible = visible && !root.hidden;
    if ([root isKindOfClass:[GhosttyHostView class]]) {
        ghostty_surface_t s = [(GhosttyHostView *)root surface];
        if (s) ghostty_surface_set_occlusion(s, selfVisible);
    }
    for (NSView *sub in root.subviews) {
        sync_surface_visibility_from_hidden(sub, selfVisible);
    }
}

static void set_subtree_visible(NSView *root, BOOL visible) {
    if (!root) return;
    NSMutableArray<GhosttyHostView *> *hosts = [NSMutableArray array];
    collect_hosts(root, hosts);
    for (GhosttyHostView *host in hosts) {
        ghostty_surface_t s = [host surface];
        if (s) ghostty_surface_set_occlusion(s, visible);
    }
    root.hidden = !visible;
}

static NSArray<NSDictionary *> *snapshot_subtree_layout(NSView *root) {
    if (!root) return @[];
    NSMutableArray<NSDictionary *> *out = [NSMutableArray array];
    NSMutableArray<NSView *> *stack = [NSMutableArray arrayWithObject:root];
    while (stack.count > 0) {
        NSView *view = stack.lastObject;
        [stack removeLastObject];
        NSMutableDictionary *entry = [@{
            @"view": [NSValue valueWithNonretainedObject:view],
            @"hidden": @(view.hidden),
        } mutableCopy];
        if ([view isKindOfClass:[NSSplitView class]]) {
            NSSplitView *split = (NSSplitView *)view;
            CGFloat axis = split.isVertical ? split.bounds.size.width
                                            : split.bounds.size.height;
            NSMutableArray<NSNumber *> *ratios = [NSMutableArray array];
            for (NSInteger i = 0; i < (NSInteger)split.arrangedSubviews.count - 1; i++) {
                NSView *child = split.arrangedSubviews[i];
                CGFloat dividerPosition = split.isVertical
                    ? NSMaxX(child.frame)
                    : NSMaxY(child.frame);
                CGFloat ratio = axis > 0 ? dividerPosition / axis : 0;
                [ratios addObject:@(ratio)];
            }
            entry[@"dividerRatios"] = ratios;
        }
        [out addObject:entry];
        for (NSView *sub in view.subviews) [stack addObject:sub];
    }
    return out;
}

static void restore_subtree_layout(NSArray<NSDictionary *> *snapshot) {
    NSMutableArray<NSDictionary *> *splitEntries = [NSMutableArray array];
    for (NSDictionary *entry in snapshot) {
        NSView *view = [entry[@"view"] nonretainedObjectValue];
        if (!view) continue;
        view.hidden = [entry[@"hidden"] boolValue];
        if ([view isKindOfClass:[NSSplitView class]]) {
            objc_setAssociatedObject(view, kSuppressDividerKey, @NO,
                                     OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            [view setNeedsDisplay:YES];
        }
        if (entry[@"dividerRatios"]) [splitEntries addObject:entry];
    }
    for (NSDictionary *entry in splitEntries) {
        NSSplitView *split = [entry[@"view"] nonretainedObjectValue];
        if (![split isKindOfClass:[NSSplitView class]]) continue;
        [split adjustSubviews];
        CGFloat axis = split.isVertical ? split.bounds.size.width
                                        : split.bounds.size.height;
        NSArray<NSNumber *> *ratios = entry[@"dividerRatios"];
        for (NSInteger i = 0; i < (NSInteger)ratios.count; i++) {
            [split setPosition:axis * ratios[i].doubleValue ofDividerAtIndex:i];
        }
    }
}

static void apply_zoom_layout(NSView *tab_root, GhosttyHostView *target) {
    if (!tab_root || !target) return;
    NSMutableArray<NSSplitView *> *allSplits = [NSMutableArray array];
    collect_splits(tab_root, allSplits);
    for (NSSplitView *split in allSplits) {
        objc_setAssociatedObject(split, kSuppressDividerKey, @NO,
                                 OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        [split setNeedsDisplay:YES];
    }
    NSView *current = target;
    while (current && current != tab_root) {
        NSView *parent = current.superview;
        if (!parent) break;
        if ([parent isKindOfClass:[NSSplitView class]]) {
            objc_setAssociatedObject(parent, kSuppressDividerKey, @YES,
                                     OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            [parent setNeedsDisplay:YES];
            for (NSView *child in parent.subviews) {
                set_subtree_visible(child, child == current);
            }
            current.frame = parent.bounds;
        }
        current = parent;
    }
}

static void restore_tab_zoom(NSView *tab_root) {
    if (!tab_root) return;
    BOOL tab_was_visible = !tab_root.hidden;
    NSArray<NSDictionary *> *snapshot = objc_getAssociatedObject(tab_root, kZoomSnapshotKey);
    if (snapshot) restore_subtree_layout(snapshot);
    objc_setAssociatedObject(tab_root, kZoomedHostKey, nil, OBJC_ASSOCIATION_ASSIGN);
    objc_setAssociatedObject(tab_root, kZoomSnapshotKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    tab_root.hidden = !tab_was_visible;
    sync_surface_visibility_from_hidden(tab_root, tab_was_visible);
}

static void clear_tab_zoom_for_descendant(NSView *view) {
    NSView *tab_root = tab_root_for_descendant(view);
    GhosttyHostView *zoomed = tab_root
        ? objc_getAssociatedObject(tab_root, kZoomedHostKey)
        : nil;
    if (zoomed) restore_tab_zoom(tab_root);
}

static BOOL toggle_tab_zoom_for_host(GhosttyHostView *target) {
    if (!target) return NO;
    NSView *tab_root = tab_root_for_descendant(target);
    if (!tab_root || !tab_has_multiple_panes(tab_root)) return NO;

    GhosttyHostView *zoomed = objc_getAssociatedObject(tab_root, kZoomedHostKey);
    if (zoomed == target) {
        restore_tab_zoom(tab_root);
        return YES;
    }

    if (zoomed) restore_tab_zoom(tab_root);
    objc_setAssociatedObject(tab_root, kZoomSnapshotKey,
                             snapshot_subtree_layout(tab_root),
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(tab_root, kZoomedHostKey, target, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    apply_zoom_layout(tab_root, target);
    [target.window makeFirstResponder:target];
    return YES;
}

static void reapply_tab_zoom_if_needed(NSView *tab_root) {
    if (!tab_root) return;
    GhosttyHostView *zoomed = objc_getAssociatedObject(tab_root, kZoomedHostKey);
    if (!zoomed) return;
    if (![zoomed isKindOfClass:[GhosttyHostView class]]) {
        restore_tab_zoom(tab_root);
        return;
    }
    apply_zoom_layout(tab_root, zoomed);
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
    clear_tab_zoom_for_descendant(focused);
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
    clear_tab_zoom_for_descendant(focused);
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
    sc.userdata = (__bridge void *)newHost;
    sc.platform_tag = GHOSTTY_PLATFORM_MACOS;
    sc.platform.macos.nsview = (__bridge void *)newHost;

    ghostty_surface_t newSurface = ghostty_surface_new(
        (ghostty_app_t)appPtr, &sc);
    if (!newSurface) {
        NSLog(@"[ghostty] new_split: ghostty_surface_new failed");
        return;
    }
    [newHost setSurface:newSurface];

    // Always wrap the focused leaf in a fresh binary split. Matching
    // Ghostty's immutable SplitTree semantics means only the selected
    // pane is halved; unrelated siblings keep their order and divider
    // geometry. The previous n-ary flatten/equalize path moved every
    // sibling whenever a same-axis split was created.
    BOOL wantHorizontal = split_is_horizontal(dir);
    NSSplitView *targetSplit = wrap_leaf_with_binary_split(
        focusedHost, newHost, wantHorizontal, split_inserts_after(dir));
    if (!targetSplit) {
        [newHost setSurface:NULL];
        ghostty_surface_free(newSurface);
        NSLog(@"[ghostty] new_split: failed to insert split tree node");
        return;
    }

    // Tag every split-created host view
    // so GhosttyTabClose can distinguish it from the original
    // Rust-tracked host view and free its surface during tab close.
    // Without this, splits created via cmd+d/cmd+\ would leak surfaces
    // when the parent tab closes (Rust's TabState.surfaces only
    // tracks the original spawn surface — see commands.rs::
    // spawn_tab_native), AND the dangling g_host_view → freed pane
    // pointer would crash the next event dispatch.
    objc_setAssociatedObject(newHost, kSplitCreatedKey, @YES,
                             OBJC_ASSOCIATION_RETAIN_NONATOMIC);

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
typedef bool (*GhosttyPaneClosedFn)(void *surface);
static GhosttyPaneClosedFn g_pane_closed_fn = NULL;

void GhosttyRegisterTabActionCallback(GhosttyTabActionFn fn) {
    g_tab_action_fn = fn;
}

void GhosttyRegisterPaneClosedCallback(GhosttyPaneClosedFn fn) {
    g_pane_closed_fn = fn;
}

static void dispatch_tab_action(int kind, long arg) {
    if (g_tab_action_fn) g_tab_action_fn(kind, arg);
}

// Reload-config callback slot. Wired by Rust at terminal_new time —
// fires from the GHOSTTY_ACTION_RELOAD_CONFIG case in the action
// handler below. The actual `GhosttyRegisterReloadConfigCallback`
// registration entry point lives further down with the other
// callback-registration entry points; only the typedef + slot live
// here so the action handler (immediately below) can reference them.
typedef void (*GhosttyReloadConfigFn)(void *app, bool soft);
static GhosttyReloadConfigFn g_reload_config_fn = NULL;

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
            int tab_id = tab_id_for_target(tgt);
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
        case GHOSTTY_ACTION_PWD: {
            int tab_id = tab_id_for_target(tgt);
            const char *pwd_c = act->action.pwd.pwd;
            NSString *pwd = (pwd_c ? [NSString stringWithUTF8String:pwd_c] : nil);
            if (tab_id != 0) {
                emit_tab_event(TAB_EVENT_PWD, tab_id, pwd);
            }
            return true;
        }
        case GHOSTTY_ACTION_PROGRESS_REPORT: {
            int tab_id = status_tab_id_for_target(tgt);
            if (tab_id != 0) {
                emit_terminal_status_event(
                    TERMINAL_STATUS_EVENT_PROGRESS,
                    tab_id,
                    (long long)act->action.progress_report.state,
                    (long long)act->action.progress_report.progress,
                    nil,
                    nil);
            }
            return true;
        }
        case GHOSTTY_ACTION_COMMAND_FINISHED: {
            int tab_id = status_tab_id_for_target(tgt);
            if (tab_id != 0) {
                emit_terminal_status_event(
                    TERMINAL_STATUS_EVENT_COMMAND_FINISHED,
                    tab_id,
                    (long long)act->action.command_finished.exit_code,
                    saturating_u64_to_i64(act->action.command_finished.duration),
                    nil,
                    nil);
            }
            return true;
        }
        case GHOSTTY_ACTION_DESKTOP_NOTIFICATION: {
            int tab_id = status_tab_id_for_target(tgt);
            if (tab_id != 0) {
                const char *title_c = act->action.desktop_notification.title;
                const char *body_c = act->action.desktop_notification.body;
                NSString *title = title_c ? [NSString stringWithUTF8String:title_c] : nil;
                NSString *body = body_c ? [NSString stringWithUTF8String:body_c] : nil;
                emit_terminal_status_event(
                    TERMINAL_STATUS_EVENT_DESKTOP_NOTIFICATION,
                    tab_id,
                    0,
                    0,
                    title,
                    body);
            }
            return true;
        }
        case GHOSTTY_ACTION_SHOW_CHILD_EXITED: {
            int tab_id = status_tab_id_for_target(tgt);
            if (tab_id != 0) {
                emit_terminal_status_event(
                    TERMINAL_STATUS_EVENT_CHILD_EXITED,
                    tab_id,
                    (long long)act->action.child_exited.exit_code,
                    saturating_u64_to_i64(act->action.child_exited.timetime_ms),
                    nil,
                    nil);
            }
            return true;
        }
        case GHOSTTY_ACTION_RENDERER_HEALTH: {
            int tab_id = status_tab_id_for_target(tgt);
            if (tab_id != 0) {
                emit_terminal_status_event(
                    TERMINAL_STATUS_EVENT_RENDERER_HEALTH,
                    tab_id,
                    act->action.renderer_health == GHOSTTY_RENDERER_HEALTH_HEALTHY ? 1 : 0,
                    0,
                    nil,
                    nil);
            }
            return true;
        }
        case GHOSTTY_ACTION_START_SEARCH: {
            if (!tgt || tgt->tag != GHOSTTY_TARGET_SURFACE) return false;
            ghostty_surface_t search_surface = tgt->target.surface;
            GhosttyHostView *search_host = host_view_for_surface(search_surface);
            atomic_store(&g_search_surface, search_surface);
            const char *needle_c = act->action.start_search.needle;
            NSString *needle = needle_c ? [NSString stringWithUTF8String:needle_c] : @"";
            [search_host beginNativeSearchWithNeedle:needle];
            return true;
        }
        case GHOSTTY_ACTION_END_SEARCH: {
            if (!tgt || tgt->tag != GHOSTTY_TARGET_SURFACE) return false;
            ghostty_surface_t search_surface = tgt->target.surface;
            GhosttyHostView *search_host = host_view_for_surface(search_surface);
            [search_host endNativeSearch];
            if (atomic_load(&g_search_surface) == search_surface) {
                atomic_store(&g_search_surface, NULL);
            }
            return true;
        }
        case GHOSTTY_ACTION_SEARCH_TOTAL: {
            if (!tgt || tgt->tag != GHOSTTY_TARGET_SURFACE) return false;
            ghostty_surface_t search_surface = tgt->target.surface;
            [host_view_for_surface(search_surface)
                updateNativeSearchTotal:(NSInteger)act->action.search_total.total];
            return true;
        }
        case GHOSTTY_ACTION_SEARCH_SELECTED: {
            if (!tgt || tgt->tag != GHOSTTY_TARGET_SURFACE) return false;
            ghostty_surface_t search_surface = tgt->target.surface;
            [host_view_for_surface(search_surface)
                updateNativeSearchSelected:(NSInteger)act->action.search_selected.selected];
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
            int tab_id = status_tab_id_for_target(target);
            if (tab_id > 0) {
                emit_terminal_status_event(
                    TERMINAL_STATUS_EVENT_BELL,
                    tab_id,
                    0,
                    0,
                    nil,
                    nil);
            }
            NSBeep();
            return true;
        }
        case GHOSTTY_ACTION_NEW_SPLIT: {
            NSLog(@"[ghostty] action: NEW_SPLIT direction=%d", act->action.new_split);
            NSView *focused = nil;
            if (tgt && tgt->tag == GHOSTTY_TARGET_SURFACE) {
                focused = host_view_for_surface(tgt->target.surface);
            }
            if (!focused) focused = (__bridge NSView *)atomic_load(&g_host_view);
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
        case GHOSTTY_ACTION_TOGGLE_SPLIT_ZOOM: {
            NSView *focused = (__bridge NSView *)atomic_load(&g_host_view);
            if (![focused isKindOfClass:[GhosttyHostView class]]) return false;
            return toggle_tab_zoom_for_host((GhosttyHostView *)focused);
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
            int tabId = tab_id_for_target(tgt);
            dispatch_async(dispatch_get_main_queue(), ^{
                dispatch_tab_action(TAB_ACTION_CLOSE, tabId);
            });
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
        case GHOSTTY_ACTION_RELOAD_CONFIG: {
            // ghostty fires this most importantly after
            // `ghostty_app_set_color_scheme` updates the internal
            // conditional theme state — without us building + pushing
            // a fresh config back via `ghostty_app_update_config`,
            // the theme switch is a visual no-op. Forwarded to Rust
            // because the Config wrapper + finalisation lives there.
            //
            // Soft = true: scheme/conditional change (don't re-read
            // user config files, just re-derive). Soft = false: full
            // user-initiated reload.
            //
            // The trampoline accepts either via `bool soft` and
            // currently always rebuilds from scratch; refining the
            // soft path is a future optimisation.
            if (g_reload_config_fn) {
                g_reload_config_fn(app, act->action.reload_config.soft);
            }
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
static void perform_close_pane(GhosttyHostView *pane) {
    NSView *tabRoot = pane ? tab_root_for_descendant(pane) : nil;
    if (!pane || !tabRoot) return;
    BOOL shouldRefocus = !tabRoot.hidden &&
        (pane.window.firstResponder == pane ||
         [pane nativeSearchOwnsFocus] ||
         atomic_load(&g_host_view) == (__bridge void *)pane);
    if ([pane nativeSearchOwnsFocus]) [pane endNativeSearch];
    clear_tab_zoom_for_descendant(pane);
    NSView *parent = pane.superview;

    // Case 1: parent is an NSSplitView with siblings.
    if ([parent isKindOfClass:[NSSplitView class]]
        && ((NSSplitView *)parent).arrangedSubviews.count > 1) {
        NSSplitView *split = (NSSplitView *)parent;
        NSArray<NSView *> *children = split.arrangedSubviews;
        NSUInteger idx = [children indexOfObject:pane];
        if (idx == NSNotFound) return;
        NSView *sibling = idx + 1 < children.count
            ? children[idx + 1]
            : (idx > 0 ? children[idx - 1] : nil);
        GhosttyHostView *next = find_first_host_descendant(sibling);

        // Surface ownership is split between Rust (original tab pane)
        // and ObjC (split-created panes). Notify Rust synchronously for
        // its pane so its View is removed and dropped exactly once.
        ghostty_surface_t s = pane.surface;
        BOOL accepted = s == NULL;
        if (s && is_split_created(pane)) {
            accepted = YES;
        } else if (s && g_pane_closed_fn) {
            accepted = g_pane_closed_fn((void *)s);
        }
        if (!accepted) {
            NSLog(@"[ghostty] refusing to detach Rust-owned pane not found by owner");
            return;
        }
        [pane setSurface:NULL];
        if (s && is_split_created(pane)) {
            GhosttyClearClipboardSurfaceIfMatches(s);
            GhosttyDeferSurfaceFree(s);
        }
        [pane removeFromSuperview];
        collapse_split_after_removal(split);
        if (next && shouldRefocus) [next.window makeFirstResponder:next];
        return;
    }

    // Case 2: only pane in this tab — dispatch CLOSE_TAB to Rust which
    // handles the close-window-on-last-tab policy + Tauri events.
    int tabId = tab_id_get(tabRoot);
    dispatch_async(dispatch_get_main_queue(), ^{
        dispatch_tab_action(TAB_ACTION_CLOSE, tabId);
    });
}

void GhosttyHandleCloseSurface(void *host_view, bool needs_confirmation) {
    (void)needs_confirmation; // Confirmation UI remains a future host policy.
    NSView *view = (__bridge NSView *)host_view;
    if (![view isKindOfClass:[GhosttyHostView class]]) return;
    perform_close_pane((GhosttyHostView *)view);
}

static GhosttyHostView *host_owning_native_search_focus(NSWindow *window) {
    if (!window || !g_tab_container || g_tab_container.window != window) return nil;
    NSMutableArray<GhosttyHostView *> *hosts = [NSMutableArray array];
    collect_hosts(g_tab_container, hosts);
    for (GhosttyHostView *host in hosts) {
        if ([host nativeSearchOwnsFocus]) return host;
    }
    return nil;
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

// Embedding-host passthrough callback. Wired by Rust at terminal_new
// time; fires when the NSEvent monitor sees a chord we want the
// embedding host (zen-tools) to handle instead of forwarding to
// ghostty. Currently used for the distraction-free toggle
// (cmd+opt+f), which the host hides its TitleBar in response to.
//
// String values are stable identifiers chosen by this module
// (for example "cmd-opt-f", "cmd-left-bracket", or "cmd-shift-n").
// Hosts that don't care can ignore the callback entirely; the chord
// is consumed regardless so it doesn't reach ghostty as a stray
// keystroke.
typedef void (*GhosttyHostKeyHookFn)(const char *chord);
static GhosttyHostKeyHookFn g_host_key_hook_fn = NULL;

void GhosttyRegisterHostKeyHookCallback(GhosttyHostKeyHookFn fn) {
    g_host_key_hook_fn = fn;
}

// Reload-config callback registration entry point. The typedef and
// static slot itself live higher in the file (near other action-side
// state) because GhosttyHandleAction's RELOAD_CONFIG case needs to
// reference the slot — C requires the declaration before use.
void GhosttyRegisterReloadConfigCallback(GhosttyReloadConfigFn fn) {
    g_reload_config_fn = fn;
}

void GhosttyInstallEventMonitor(ghostty_surface_t surface) {
    // The `surface` argument is no longer used as a fallback target —
    // the monitor now resolves the target dynamically from the
    // window's firstResponder + the `g_host_view` cache, so the
    // install-time surface would be a stale answer the moment a split
    // / new tab takes focus. Kept as a parameter so callers
    // (commands.rs:terminal_new) don't have to change signatures, but
    // intentionally unreferenced here.
    (void)surface;
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
            // unhandled keystrokes.
            //
            // cmd+opt+f → host distraction-free toggle. Match
            // exactly cmd+opt (no shift / ctrl) so cmd+opt+shift+f
            // and friends still flow to ghostty.
            NSEventModifierFlags devMods = event.modifierFlags &
                (NSEventModifierFlagCommand | NSEventModifierFlagOption |
                 NSEventModifierFlagShift   | NSEventModifierFlagControl);
            NSString *chars = event.charactersIgnoringModifiers;
            NSResponder *fr = event.window.firstResponder;
            GhosttyHostView *searchHost =
                host_owning_native_search_focus(event.window);

            // While the native search field owns AppKit's shared field
            // editor, Cmd+F selects its current query again. Without this
            // special case AppKit sees only an NSTextView responder and the
            // terminal binding never receives the repeat command.
            if (searchHost && devMods == NSEventModifierFlagCommand &&
                [chars isEqualToString:@"f"]) {
                [searchHost beginNativeSearchWithNeedle:@""];
                return nil;
            }

            // Cmd+W belongs to the active in-app tab, never the host
            // window. When focus is in the webview, hand the chord to
            // React before AppKit can turn it into performClose:. Native
            // terminal focus still flows through ghostty below so it can
            // close a split or terminal tab directly.
            if (devMods == NSEventModifierFlagCommand
                && [chars isEqualToString:@"w"]
                && ![fr isKindOfClass:[GhosttyHostView class]] && !searchHost) {
                if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-w");
                return nil;
            }

            if (devMods == (NSEventModifierFlagCommand | NSEventModifierFlagOption)
                && [chars isEqualToString:@"f"]) {
                if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-opt-f");
                return nil; // consume — do NOT forward to ghostty
            }

            // Only intercept when a GhosttyHostView is actually the
            // window's first responder. Without this gate the monitor
            // is application-wide and steals every Cmd-shortcut even
            // when the user is on /database-explorer, /markdown, etc.
            // — eating Cmd+C / Cmd+V / Cmd+A across the whole app.
            //
            // We check `event.window.firstResponder` rather than only
            // the cached `g_host_view` pointer because the cache can
            // legitimately lag (the user just clicked into the
            // webview; AppKit moved focus before our
            // `resignFirstResponder` runs). The cached pointer is
            // still useful as the *target* for the dispatch when we
            // DO intercept (it survives splits — `becomeFirstResponder`
            // updates it before keyDown lands), so we use both:
            //   * firstResponder check → SHOULD we intercept at all?
            //   * g_host_view → WHICH surface gets the event?
            if (![fr isKindOfClass:[GhosttyHostView class]] && !searchHost) {
                return event; // pass through to AppKit / WKWebView
            }

            if (devMods == NSEventModifierFlagCommand) {
                if ([chars isEqualToString:@"["]) {
                    if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-left-bracket");
                    return nil;
                }
                if ([chars isEqualToString:@"]"]) {
                    if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-right-bracket");
                    return nil;
                }
                if ([chars isEqualToString:@"n"]) {
                    if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-n");
                    return nil;
                }
                if (chars.length == 1) {
                    unichar digit = [chars characterAtIndex:0];
                    if (digit >= '1' && digit <= '9') {
                        if (g_host_key_hook_fn) {
                            char chord[6] = {'c', 'm', 'd', '-', (char)digit, '\0'};
                            g_host_key_hook_fn(chord);
                        }
                        return nil;
                    }
                }
            }

            if (devMods == (NSEventModifierFlagCommand | NSEventModifierFlagShift)) {
                // charactersIgnoringModifiers keeps Shift applied on macOS, so
                // Shift+[ produces "{" rather than "[". Check both to be safe
                // across macOS versions and keyboard layouts.
                if ([chars isEqualToString:@"["] || [chars isEqualToString:@"{"]) {
                    if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-shift-left-bracket");
                    return nil;
                }
                if ([chars isEqualToString:@"]"] || [chars isEqualToString:@"}"]) {
                    if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-shift-right-bracket");
                    return nil;
                }
                if ([chars isEqualToString:@"n"] || [chars isEqualToString:@"N"]) {
                    if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-shift-n");
                    return nil;
                }
                if ([chars isEqualToString:@"e"] || [chars isEqualToString:@"E"]) {
                    if (g_host_key_hook_fn) g_host_key_hook_fn("cmd-shift-e");
                    return nil;
                }
            }

            // Look up the CURRENTLY focused pane (not the cached one
            // from install time). With splits, the focused surface
            // changes — without this lookup, every Cmd-shortcut
            // (Cmd+=/-/0 font size, Cmd+W close, Cmd+C copy) targets
            // pane #1 forever. Falls back to the firstResponder
            // surface itself when the cache is stale.
            ghostty_surface_t target = NULL;
            if (searchHost) target = searchHost.surface;
            void *vp = atomic_load(&g_host_view);
            if (!target && vp) {
                NSView *view = (__bridge NSView *)vp;
                if ([view isKindOfClass:[GhosttyHostView class]]) {
                    target = [(GhosttyHostView *)view surface];
                }
            }
            if (!target && [fr isKindOfClass:[GhosttyHostView class]]) {
                target = [(GhosttyHostView *)fr surface];
            }
            if (!target) {
                // No surface to forward to — let AppKit dispatch
                // normally rather than swallowing the keystroke.
                return event;
            }
            // Standard editor commands must keep operating on the search
            // query. Structural shortcuts were consumed above; Cmd+W and
            // font-size bindings remain terminal-scoped while searching.
            if (searchHost) {
                BOOL terminalBinding = devMods == NSEventModifierFlagCommand &&
                    ([chars isEqualToString:@"w"] ||
                     [chars isEqualToString:@"="] ||
                     [chars isEqualToString:@"+"] ||
                     [chars isEqualToString:@"-"] ||
                     [chars isEqualToString:@"0"]);
                if (!terminalBinding) return event;
            }
            send_key_event(target, event, GHOSTTY_ACTION_PRESS);
            return nil;
        }];
}

void GhosttyRemoveEventMonitor(void) {
    if (g_event_monitor) {
        [NSEvent removeMonitor:g_event_monitor];
        g_event_monitor = nil;
    }
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

void GhosttyClearClipboardSurfaceIfMatches(ghostty_surface_t surface) {
    void *expected = surface;
    atomic_compare_exchange_strong(&g_clipboard_surface, &expected, NULL);
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
