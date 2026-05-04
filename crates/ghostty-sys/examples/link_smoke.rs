// link_smoke.rs — tiny smoke test that exercises the FFI link path. We
// don't construct an app (that needs a runtime config + callbacks); we
// just take the address of `ghostty_init` and `ghostty_app_new`. If the
// linker can resolve them, that proves libghostty.a + frameworks are
// wired up. Run with:
//
//   GHOSTTY_LIB_DIR=/tmp/ghostty-install/lib cargo run -p ghostty-sys --example link_smoke

fn main() {
    // Take addresses (requires the symbols to be linked but doesn't call them).
    // The unsafe is just for the FFI fn pointer cast — no UB.
    let init_addr = ghostty_sys::ghostty_init as *const () as usize;
    let app_new_addr = ghostty_sys::ghostty_app_new as *const () as usize;
    let surface_new_addr = ghostty_sys::ghostty_surface_new as *const () as usize;
    println!("ghostty_init        @ {:#x}", init_addr);
    println!("ghostty_app_new     @ {:#x}", app_new_addr);
    println!("ghostty_surface_new @ {:#x}", surface_new_addr);
    assert!(init_addr != 0);
    assert!(app_new_addr != 0);
    assert!(surface_new_addr != 0);
    println!("link smoke: OK");
}
