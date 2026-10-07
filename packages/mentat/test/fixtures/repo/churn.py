# AcmeCorp churn model helpers (fixture).
import pandas as pd

ACME_CHURN_THRESHOLD = 0.75


def load_acme_customers(path):
    frame = pd.read_csv(path)
    return frame


def flag_churn_risk(frame):
    scored = frame.copy()
    scored["churn_risk"] = scored["months_since_login"] > 6
    return scored[scored["churn_risk"]]
