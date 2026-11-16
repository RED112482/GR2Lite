"""Wire contract v0.1: metadata JSON + binary float32 radar moments.

A sweep is a native polar cut. Values are NOT regridded. Gate start/spacing
can differ by moment; only the reader's actual geometry is serialized.
"""
from datetime import datetime
from enum import Enum
from typing import Literal
from pydantic import BaseModel, Field, model_validator


class Moment(str, Enum):
    REF = "REF"
    VEL = "VEL"
    SW = "SW"
    ZDR = "ZDR"
    CC = "CC"
    PHI = "PHI"
    KDP = "KDP"


class MomentDescriptor(BaseModel):
    name: Moment
    source_variable: str
    units: str
    rays: int = Field(gt=0)
    gates: int = Field(gt=0)
    first_gate_m: float = Field(ge=0)
    gate_spacing_m: float = Field(gt=0)
    encoding: Literal["float32-le"] = "float32-le"
    missing: Literal["NaN"] = "NaN"


class SweepDescriptor(BaseModel):
    id: str
    index: int = Field(ge=0)
    fixed_angle_deg: float
    ray_count: int = Field(gt=0)
    azimuth_deg: list[float]
    elevation_deg: list[float]
    time_utc: list[datetime]
    moments: dict[Moment, MomentDescriptor]

    @model_validator(mode="after")
    def validate_lengths(self):
        n = self.ray_count
        if len(self.azimuth_deg) != n or len(self.elevation_deg) != n or len(self.time_utc) != n:
            raise ValueError("Each radial metadata array must match ray_count")
        for name, moment in self.moments.items():
            if name != moment.name or moment.rays != n:
                raise ValueError("Moment and radial geometry disagree")
        return self


class VolumeDescriptor(BaseModel):
    contract_version: Literal["0.1.0"] = "0.1.0"
    volume_id: str
    radar_id: str = Field(pattern=r"^K[A-Z0-9]{3}$")
    source: Literal["archive"] = "archive"
    vcp: str | None = None
    volume_complete: bool = False
    radar_lat: float = Field(ge=-90, le=90)
    radar_lon: float = Field(ge=-180, le=180)
    radar_alt_m: float | None = None
    sweeps: list[SweepDescriptor]
