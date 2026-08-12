# 공통 통계 — 05_report.py 와 07_metrics.py 가 같은 함수를 쓰도록 한 곳에 둔다.
# 비율의 신뢰구간은 Wilson 점수구간을 쓴다: n 이 작고 p 가 0/1 에 가까울 때
# 정규근사(p ± z·√(p(1-p)/n))는 구간이 0 미만/100 초과로 나가거나 지나치게 좁아진다.
import math

Z95 = 1.959964


def wilson(k: int, n: int) -> tuple[float, float]:
    """이항비율 k/n 의 95% Wilson 점수구간을 퍼센트로 반환."""
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + Z95 * Z95 / n
    center = (p + Z95 * Z95 / (2 * n)) / d
    half = Z95 / d * math.sqrt(p * (1 - p) / n + Z95 * Z95 / (4 * n * n))
    return (round(100 * max(0.0, center - half), 1),
            round(100 * min(1.0, center + half), 1))


def mean_ci(xs: list[float]) -> tuple[float, float, float]:
    """평균, 표본표준편차, 95% 신뢰구간 반폭(평균 ± 이 값)."""
    n = len(xs)
    if n == 0:
        return (0.0, 0.0, 0.0)
    m = sum(xs) / n
    if n == 1:
        return (m, 0.0, 0.0)
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))
    return (m, sd, Z95 * sd / math.sqrt(n))


def pct_cell(k: int, n: int) -> str:
    """표에 넣을 '65.0% (39/60, CI 52.4~75.8)' 문자열."""
    if n == 0:
        return "—"
    lo, hi = wilson(k, n)
    return f"{round(100 * k / n, 1)}% ({k}/{n}, CI {lo}~{hi})"
