# Curate extracted modern-DO UI sprites/fonts into client/public/assets/ui/.
# Inputs (regenerate with tools/ui_export_sprites.py / ui_export_fonts.py):
#   extracted/ui_sprites/ui/*.png   (ui_assets bundle sprites)
#   extracted/ui_atlas/<Atlas>/*.png (atlas_assets SpriteAtlas sprites)
#   extracted/ui_fonts/*.ttf
import os, shutil, glob, json
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EX = os.path.join(R, 'extracted'); OUT = os.path.join(R, 'client/public/assets/ui')
UI = os.path.join(EX, 'ui_sprites/ui'); AT = os.path.join(EX, 'ui_atlas')
def cp(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(src): shutil.copyfile(src, dst); return True
    print('missing', src); return False
WIN = '''backgroundHeader_ControlsWide backgroundBody_Normal1 backgroundBody_Normal_line backgroundBody_ControlsWide
backgroundBody_bg minimize_button drag_standard bar_background bar_green bar_blue bar_red bar_yellow bar_outer shild_small id
plus_button_standard minus_button_standard tab2_active tab2_hover tab2_normal horizontal_divider divider_slope
itemlist_entry_bg_normal itemlist_entry_bg_hover InputFieldBackground vertical-arrowUp vertical-arrowDown vertical-thumb vertical-track
scale9btn_blue_normal scale9btn_blue_hover scale9btn_blue_active scale9btn_green_normal scale9btn_green_hover scale9btn_green_active
scale9btn_disabled small_tabs_active small_tabs_inactive bigtab_hover bigtab_nomal smalltab_hover smalltab_nomal itembg itemhover
equipment_slotbar_background_grey equipment_itemslot_selected_30x30 equipment_led_on equipment_led_off equipment_icon_info
slot_item_select_42x42 33_inventory_slot_selected 34_inventory_slot_hover inventory_slot_destroyed mid_green_nomal mid_green_hover mid_green_select
btn_hologram_green_152x36_0 btn_hologram_green_152x36_1 btn_hologram_green_152x36_2 popup_header popup_middle 72 70
checkbox16x16_blue_normal_selected checkbox16x16_blue_normal_unselected checkbox16x16_blue_over_selected checkbox16x16_blue_over_unselected
16_slider_background 20_slider_knob 24_slider_line 25_slider_bg refresh_normal refresh_hover btn_scroll_left_normal btn_scroll_right_normal
faction_logo_small_mmo faction_logo_small_eic faction_logo_small_vru logo_faction_mmo_17x17 logo_faction_eic_17x17 logo_faction_vru_17x17
logo_rework_darkorbit logo_rework_darkorbit_175x65 faction_logo_MMO faction_logo_EIC faction_logo_VRU tooltipbg bg_tooltip
button_sprite_115x20px_0 button_sprite_115x20px_2 button_sprite_115x20px_3 button_sprite_115x20px_4 button_sprite_115x20px_5
button_sprite_150x32px_0 button_sprite_150x32px_1 button_sprite_150x32px_2 lineSeperator seperator_horizontal trennerw
targetIcon lock window_background window_header_bgnd close_button_sprite_0 close_button_sprite_1 cog_big cog_small
bg_item content_header header_bg_new hp_small xp_small 1_slotnumber_b button_red_nomal button_green_nomal button_gray_nomal button_red_hover button_green_hover'''.split()
WIN += [os.path.basename(p)[:-4] for p in glob.glob(os.path.join(UI, 'shipInfoIcon_*.png'))]
for p in glob.glob(os.path.join(EX, 'ui_sprites/company', '*.png')): cp(p, os.path.join(OUT, 'win', os.path.basename(p)))
WIN = [n for n in WIN if os.path.exists(os.path.join(UI, n + '.png'))]
for n in WIN: cp(os.path.join(UI, n + '.png'), os.path.join(OUT, 'win', n + '.png'))
for p in glob.glob(os.path.join(AT, 'FeatureMenu', '*.png')): cp(p, os.path.join(OUT, 'menu', os.path.basename(p)))
for p in glob.glob(os.path.join(AT, 'itemControlmenu', '*.png')): cp(p, os.path.join(OUT, 'bar', os.path.basename(p)))
for p in glob.glob(os.path.join(AT, 'MiniMap', '*.png')): cp(p, os.path.join(OUT, 'map', os.path.basename(p)))
for p in glob.glob(os.path.join(AT, 'Boosters', '*.png')): cp(p, os.path.join(OUT, 'boost', os.path.basename(p)))
for p in glob.glob(os.path.join(AT, 'bitmapFont', '*.png')): cp(p, os.path.join(OUT, 'digits', os.path.basename(p)))
SLOT = {'background__2': 'slot_bg', 'backgroundRound': 'slot_bg_round', 'brightBackground': 'slot_bright', 'activeOverlay': 'slot_active',
        'selectedState': 'slot_selected', 'rollOverState': 'slot_hover', 'mouseDownState': 'slot_down', 'blockedState': 'slot_blocked',
        'noSwitchingAmmoWarn': 'slot_warn', 'progressBar': 'slot_pb', 'progressBarBackground': 'slot_pb_bg', 'progressBarBorder': 'slot_pb_border',
        'highlight_flash_deactivation': 'slot_flash', 'dot_border_bg': 'slot_dot', 'dotTintArea': 'slot_dot_tint'}
for s, d in SLOT.items(): cp(os.path.join(AT, 'Items', s + '.png'), os.path.join(OUT, 'bar', d + '.png'))
# item icons keyed by game ids: items/<id>.png (100x100) + items/<id>_30.png
ITEMS = {'x1': 'lcb-10', 'x2': 'mcb-25', 'x3': 'mcb-50', 'x4': 'ucb-100', 'sab': 'sab-50', 'rsb': 'rsb-75',
         'r310': 'r-310', 'plt2026': 'plt-2026', 'plt2021': 'plt-2021', 'plt3030': 'plt-3030',
         'lf1': 'lf-1', 'mp1': 'mp-1', 'lf2': 'lf-2', 'lf3': 'lf-3', 'lf4': 'lf-4', 'prometheus': 'prometheus-sales',
         'flax': 'flax-0', 'iris': 'iris-0', 'apis': 'apis-0', 'zeus': 'zeus-0', 'havoc': 'havoc', 'hercules': 'hercules'}
for n in ['sg3n-a01', 'sg3n-a02', 'sg3n-a03', 'sg3n-b01', 'sg3n-b02', 'sg3n-b00', 'sg3n-b03', 'fs-01', 'fs-02', 'fs-03',
          'g3n-1010', 'g3n-2010', 'g3n-3210', 'g3n-3310', 'g3n-6900', 'g3n-7900',
          'rep-1', 'rep-2', 'rep-3', 'rep-4', 'aim-01', 'aim-02', 'arol-x',
          'dmg-b01', 'dmg-b02', 'hp-b01', 'hp-b02', 'shd-b01', 'shd-b02', 'ep-b01', 'ep-b02', 'hon-b01', 'hon-b02',
          'rep-b01', 'rep-b02', 'res-b01', 'res-b02']: ITEMS[n] = n
ITEMS.update({'lf4-u': 'lf-4-unstable', 'lf4-md': 'lf-4-md', 'lf4-pd': 'lf-4-pd', 'lf4-hp': 'lf-4-hp', 'lf-p01': 'lf-p01',
              # no LF-5 / Odysseus / Asmodeus icons in client 0.1.4: closest stand-ins
              'lf5': 'lf-px01', 'lf-5': 'lf-px01', 'lf5-al': 'lf-px01', 'caucasus': 'caucasus', 'odysseus': 'caucasus', 'asmodeus': 'prometheus-sales',
              'mul-b03': 'kappa-b01'})
try:  # any new ids in data/items.json whose icon name matches directly
    d = json.load(open(os.path.join(R, 'data/items.json')))
    for k, v in d.items():
        if isinstance(v, list):
            for it in v:
                i = it.get('id')
                if not i or i in ITEMS: continue
                for cand in (i, i.replace('_', '-'), str(it.get('icon', '')), str(it.get('name', '')).lower()):
                    if cand and os.path.exists(os.path.join(AT, 'Items', cand + '_100x100.png')): ITEMS[i] = cand; break
except Exception as e: print('items.json', e)
for i, n in ITEMS.items():
    cp(os.path.join(AT, 'Items', n + '_100x100.png'), os.path.join(OUT, 'items', i + '.png'))
    if os.path.exists(os.path.join(AT, 'Items', n + '_30x30.png')): cp(os.path.join(AT, 'Items', n + '_30x30.png'), os.path.join(OUT, 'items', i + '_30.png'))
for f in ['EurostileTMed.ttf', 'TAHOMA.ttf', 'tahomabd.ttf']: cp(os.path.join(EX, 'ui_fonts', f), os.path.join(OUT, 'fonts', f))
print('ui assets ->', OUT)
