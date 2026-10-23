// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev `Base8` and `2 * Base8` on Baby Jubjub, shared by every fixture that needs a signing key
/// genuinely on the curve without retyping the coordinates.
abstract contract BabyJubjubTestKeys {
    uint256 internal constant KEY_1_X =
        5_299_619_240_641_551_281_634_865_583_518_297_030_282_874_472_190_772_894_086_521_144_482_721_001_553;
    uint256 internal constant KEY_1_Y =
        16_950_150_798_460_657_717_958_625_567_821_834_550_301_663_161_624_707_787_222_815_936_182_638_968_203;
    uint256 internal constant KEY_2_X =
        10_031_262_171_927_540_148_667_355_526_369_034_398_030_886_437_092_045_105_752_248_699_557_385_197_826;
    uint256 internal constant KEY_2_Y =
        633_281_375_905_621_697_187_330_766_174_974_863_687_049_529_291_089_048_651_929_454_608_812_697_683;
}
