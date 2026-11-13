"""分层精确置换检验（小样本）与蒙特卡洛置换检验（大样本回退）。

原假设下，每层内用户标签可交换；检验保持每层原来的分组人数不变，
在每层内部重新分配处理/对照标签，统计量为按固定权重加权的分层差值
（与主分析的加权口径一致）。输出双侧 p 值。
"""

from __future__ import annotations

import itertools
import random
from dataclasses import dataclass
from math import comb

from .analysis import AnalysisResult

DEFAULT_EXACT_LIMIT = 200_000
DEFAULT_MC_REPLICATIONS = 10_000


@dataclass
class PermutationResult:
    method: str  # "exact" | "monte_carlo" | "insufficient"
    p_value: float | None
    observed_stat: float | None
    n_arrangements: int  # 精确法为枚举总数，MC 为抽样次数（含观测排列本身）
    eligible_layers: list[str]
    excluded_layers: dict[str, str]
    exact_limit: int | None = None
    seed: int | None = None


def _layer_contributions(
    n_c: int, n_t: int, total_conv: int, weight: float
) -> tuple[list[float], list[int], int]:
    """枚举对照组转化数 x 的所有可行取值。

    返回 (每个 x 的加权层差值, 每个 x 对应的排列数, x 的最小值)。
    同一 x 对应 C(n_c,x)·C(n_t,total_conv-x) 种标签排列。
    """
    lo = max(0, total_conv - n_t)
    hi = min(n_c, total_conv)
    contribs, multiplicities = [], []
    for x in range(lo, hi + 1):
        c_rate = x / n_c
        t_rate = (total_conv - x) / n_t
        contribs.append(weight * (t_rate - c_rate))
        multiplicities.append(comb(n_c, x) * comb(n_t, total_conv - x))
    return contribs, multiplicities, lo


def stratified_permutation_test(
    result: AnalysisResult,
    default_weight: float = 1.0,
    exact_limit: int = DEFAULT_EXACT_LIMIT,
    mc_replications: int = DEFAULT_MC_REPLICATIONS,
    seed: int = 42,
) -> PermutationResult:
    layer_data = []
    excluded: dict[str, str] = {}

    for name in sorted(result.layers):
        lr = result.layers[name]
        c = lr.groups.get(result.control)
        t = lr.groups.get(result.treatment)
        if c is None or t is None:
            excluded[name] = "缺少实验组"
            continue
        if c.observed == 0 or t.observed == 0:
            excluded[name] = "存在已观察人数为 0 的组"
            continue
        weight = lr.weight if lr.weight is not None else default_weight
        total_conv = c.conversions + t.conversions
        n_c, n_t = c.observed, t.observed
        # 层内无变异（全转化或全未转化）时，任何排列贡献都相同，不影响统计量
        if total_conv == 0 or total_conv == n_c + n_t:
            excluded[name] = "层内结果无变异"
            continue
        layer_data.append((name, n_c, n_t, total_conv, weight))

    if not layer_data:
        return PermutationResult(
            method="insufficient",
            p_value=None,
            observed_stat=None,
            n_arrangements=0,
            eligible_layers=[],
            excluded_layers=excluded,
            exact_limit=exact_limit,
            seed=seed,
        )

    # 每层缓存: 名称、组规模、总转化、权重、各 x 的贡献与排列数、x 最小值
    per_layer = []
    observed_stat = 0.0
    total_arrangements = 1
    for name, n_c, n_t, total_conv, weight in layer_data:
        lr = result.layers[name]
        c = lr.groups[result.control]
        contribs, multiplicities, lo = _layer_contributions(n_c, n_t, total_conv, weight)
        observed_stat += contribs[c.conversions - lo]
        total_arrangements *= comb(n_c + n_t, n_c)
        per_layer.append(
            {"name": name, "n_c": n_c, "n_t": n_t, "total_conv": total_conv,
             "weight": weight, "contribs": contribs, "mults": multiplicities, "lo": lo}
        )

    eligible = [d["name"] for d in per_layer]
    abs_obs = abs(observed_stat)

    if total_arrangements <= exact_limit:
        count_ge = 0
        ranges = [range(len(d["mults"])) for d in per_layer]
        for picks in itertools.product(*ranges):
            stat = 0.0
            multiplicity = 1
            for i, pick in enumerate(picks):
                d = per_layer[i]
                stat += d["contribs"][pick]
                multiplicity *= d["mults"][pick]
            if abs(stat) >= abs_obs - 1e-12:
                count_ge += multiplicity
        return PermutationResult(
            method="exact",
            p_value=count_ge / total_arrangements,
            observed_stat=observed_stat,
            n_arrangements=total_arrangements,
            eligible_layers=eligible,
            excluded_layers=excluded,
            exact_limit=exact_limit,
            seed=seed,
        )

    # 蒙特卡洛：层内随机重排标签（观测排列本身计入一次，分母为 n+1）
    rng = random.Random(seed)
    count_ge = 1
    for _ in range(mc_replications):
        stat = 0.0
        for d in per_layer:
            x = _hypergeometric(rng, d["n_c"] + d["n_t"], d["total_conv"], d["n_c"])
            stat += d["weight"] * (
                (d["total_conv"] - x) / d["n_t"] - x / d["n_c"]
            )
        if abs(stat) >= abs_obs - 1e-12:
            count_ge += 1
    return PermutationResult(
        method="monte_carlo",
        p_value=count_ge / (mc_replications + 1),
        observed_stat=observed_stat,
        n_arrangements=mc_replications + 1,
        eligible_layers=eligible,
        excluded_layers=excluded,
        exact_limit=exact_limit,
        seed=seed,
    )


def _hypergeometric(rng: random.Random, population: int, successes: int, draws: int) -> int:
    """无 random.hypergeometric 时的回退实现（Fisher 洗牌抽样 draws 个）。"""
    count = 0
    remaining_pop, remaining_succ = population, successes
    for _ in range(draws):
        if rng.random() < remaining_succ / remaining_pop:
            count += 1
            remaining_succ -= 1
        remaining_pop -= 1
    return count
