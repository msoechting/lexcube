#!/usr/bin/env python
# coding: utf-8

# Lexcube - Interactive 3D Data Cube Visualization
# Copyright (C) 2022 Maximilian Söchting <maximilian.soechting@uni-leipzig.de>
# 
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3 of the License, or
# (at your option) any later version.
# 
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.


import datetime
import json
import math
import asyncio
from traitlets import Unicode, Dict, Float, List, Int, validate, TraitError, Bool, Tuple
import traitlets
from typing import Union
import urllib.request

import xarray as xr
import numpy as np

from ._frontend import module_name, module_version
import ipywidgets as widgets
from lexcube.lexcube_server.src.lexcube_widget import start_tile_server_in_widget_mode

class Timer:
    def __init__(self, timeout, callback):
        self._timeout = timeout
        self._callback = callback

    async def _job(self):
        await asyncio.sleep(self._timeout)
        self._callback()

    def start(self):
        self._task = asyncio.ensure_future(self._job())

    def cancel(self):
        self._task.cancel()

DEFAULT_WIDGET_SIZE = (12.0, 8.0)

@widgets.register
class Cube3DWidget(widgets.DOMWidget):
    _model_name = Unicode('Cube3DModel').tag(sync=True)
    _model_module = Unicode(module_name).tag(sync=True)
    _model_module_version = Unicode(module_version).tag(sync=True)
    _view_name = Unicode('Cube3DView').tag(sync=True)
    _view_module = Unicode(module_name).tag(sync=True)
    _view_module_version = Unicode(module_version).tag(sync=True)

    api_metadata = Dict().tag(sync=True)

    request_progress = Dict().tag(sync=True)
    request_progress_reliable_for_timing = Bool(False).tag(sync=True)
    vmin = Float(allow_none=True).tag(sync=True)
    vmax = Float(allow_none=True).tag(sync=True)
    cmap = traitlets.Union([Unicode(), List()], default_value="viridis").tag(sync=True)
    xlim = Tuple(Int(), Int(), default_value=(-1, -1)).tag(sync=True)
    ylim = Tuple(Int(), Int(), default_value=(-1, -1)).tag(sync=True)
    zlim = Tuple(Int(), Int(), default_value=(-1, -1)).tag(sync=True)

    widget_size = Tuple(DEFAULT_WIDGET_SIZE).tag(sync=True)

    xwrap = Bool(False).tag(sync=True)
    ywrap = Bool(False).tag(sync=True)
    zwrap = Bool(False).tag(sync=True)

    overlaid_geojson = traitlets.Union([Unicode(), Dict()]).tag(sync=True)
    overlaid_geojson_color = Unicode().tag(sync=True)

    isometric_mode = Bool(False).tag(sync=True)

    def __init__(self, data_source, cmap: Union[str, list, None] = None, vmin: Union[float, None] = None, vmax: Union[float, None] = None, isometric_mode: bool = False, use_lexcube_chunk_caching: bool = True, overlaid_geojson: Unicode = "", overlaid_geojson_color: Unicode = "black", widget_size: tuple = None, **kwargs):
        super().__init__(**kwargs)
        self.cmap = cmap or self.cmap
        self.vmin = vmin
        self.vmax = vmax
        self.widget_size = widget_size or DEFAULT_WIDGET_SIZE
        self.isometric_mode = isometric_mode
        self._tile_server, self._dims, self._indices = start_tile_server_in_widget_mode(self, data_source, use_lexcube_chunk_caching)
        self._data_source = self._tile_server.data_source # tile server may have patched/modified data set
        self.overlaid_geojson = overlaid_geojson
        self.overlaid_geojson_color = overlaid_geojson_color
        if not self._tile_server:
            raise Exception("Error: Could not start tile server")
        self._tile_server.widget_update_progress = self._update_progress

    def _update_progress(self, progress: list, reliable_for_timing: bool = False):
        self.request_progress_reliable_for_timing = reliable_for_timing
        self.request_progress = { "progress": progress.copy() }

    def get_current_cube_selection(self, data_to_be_indexed = None, return_index_only: bool = False):
        a = data_to_be_indexed if data_to_be_indexed is not None else self._data_source
        if type(a) != xr.DataArray: # for non-xarray data, use numerical indices
            if return_index_only:
                return dict(x=self.xlim, y=self.ylim, z=self.zlim)
            return a[self.zlim[0]:self.zlim[1], self.ylim[0]:self.ylim[1], self.xlim[0]:self.xlim[1]]

        # for Xarray data, index based on metadata indices, not numerical indices
        source_data = self._data_source[self.zlim[0]:self.zlim[1], self.ylim[0]:self.ylim[1], self.xlim[0]:self.xlim[1]]
        index = dict([(k, np.array(source_data.indexes[k])) for k in source_data.indexes])

        if return_index_only:
            return index
        return a.sel(index)
    
    def show_sliders(self, continuous_update=True):
        return Sliders(self, self._dims, continuous_update)
    
    def overlay_geojson(self, geojson_source: Union[str, dict], color: str = "black"):
        self.overlaid_geojson_color = color
        self.overlaid_geojson = geojson_source

    @validate("overlaid_geojson")
    def _valid_geojson(self, geojson_source_proposal: Union[str, dict]):
        geojson_source = geojson_source_proposal["value"]
        geojson_string = None
        if geojson_source is None or geojson_source == "":
            return ""
        if type(self._data_source) == np.ndarray:
            print("GeoJSON overlay is only supported for xarray data sources.")
            raise TraitError("GeoJSON overlay is only supported for xarray data sources.")
        if isinstance(geojson_source, str):
            try:
                json.loads(geojson_source)
                print("Interpreting GeoJSON from given JSON string...")
            except json.JSONDecodeError:
                if geojson_source.startswith("http://") or geojson_source.startswith("https://"):
                    print("Opening GeoJSON from URL...")
                    with urllib.request.urlopen(geojson_source) as res:
                        geojson_string = res.read().decode('utf-8')
                        print(f"Downloaded GeoJSON from URL {geojson_source}.")
                else:
                    print("Opening GeoJSON from file...")
                    try:
                        with open(geojson_source, "r") as f:
                            geojson_string = f.read()
                            print(f"Loaded GeoJSON from file {geojson_source}.")
                    except FileNotFoundError:
                        raise TraitError(f"GeoJSON file {geojson_source} not found.")
        elif isinstance(geojson_source, dict):
            geojson_string = json.dumps(geojson_source)
            print(f"Interpreting GeoJSON from given dictionary object...")
        return geojson_string
    
    def savefig(self, fname: str = "", include_ui: bool = True, dpi_scale: float = 2.0):
        self.send( { "response_type": "download_figure_request", "includeUi": include_ui, "filename": fname, "dpiscale": dpi_scale } )
        print('When using Lexcube and generated images or videos, please acknowledge/cite: Söchting, M., Scheuermann, G., Montero, D., & Mahecha, M. D. (2025). Interactive Earth system data cube visualization in Jupyter notebooks. Big Earth Data, 1–15. https://doi.org/10.1080/20964471.2025.2471646')

    def save_print_template(self, fname: str = ""):
        self.send( { "response_type": "download_print_template_request", "filename": fname } )
        print('When using Lexcube and generated images or videos, please acknowledge/cite: Söchting, M., Scheuermann, G., Montero, D., & Mahecha, M. D. (2025). Interactive Earth system data cube visualization in Jupyter notebooks. Big Earth Data, 1–15. https://doi.org/10.1080/20964471.2025.2471646')

    @validate("xlim")
    def _valid_xlim(self, proposal):
        return (self.validate_boundary(proposal["value"][0], 2), self.validate_boundary(proposal["value"][1], 2))

    @validate("ylim")
    def _valid_ylim(self, proposal):
        return (self.validate_boundary(proposal["value"][0], 1), self.validate_boundary(proposal["value"][1], 1))

    @validate("zlim")
    def _valid_zlim(self, proposal):
        return (self.validate_boundary(proposal["value"][0], 0), self.validate_boundary(proposal["value"][1], 0))
    
    def validate_boundary(self, proposal, axis):
        wrapping = False
        max_value = self._data_source.shape[axis]
        if (axis == 0 and self.zwrap) or (axis == 1 and self.ywrap) or (axis == 2 and self.xwrap):
            max_value = 2 * max_value
            wrapping = True
        if proposal < 0 or proposal > max_value:
            if wrapping:
                raise TraitError(f"Boundary of axis {axis} needs to be within double the range of the data source (considering this dimension wraps around the cube): 0 <= value < {max_value}")
            raise TraitError(f"Boundary of axis {axis} needs to be within the range of the data source: 0 <= value <= {max_value}")
        return proposal
    
    def show(self, width: float | int = None, height: float | int = None):
        if (type(width) == tuple):
            width, height = width
        if (width and type(width) != float and type(width) != int) or (height and type(height) != float and type(height) != int):
            raise TraitError("Width and height need to be floats or ints")
        self.widget_size = (width or DEFAULT_WIDGET_SIZE[0], height or DEFAULT_WIDGET_SIZE[1])
        return self
    
    def plot(self, width: float | int = None, height: float | int = None):
        return self.show(width, height)



@widgets.register
class Sliders(widgets.VBox):
    def make_axis_slider(self, axis_name, total_range, selection_range, indices):
        slider = widgets.IntRangeSlider(
            value=selection_range,
            min=total_range[0],
            max=total_range[1],
            step=1,
            description=f'{axis_name}:',
            disabled=False,
            continuous_update=self.continuous_update,
            orientation='horizontal',
            readout=True,
            readout_format='d'
        )
        children = [slider]
        if len(indices) > 0 and not (indices[0] == total_range[0] and indices[-1] == total_range[1]):
            label = widgets.Label(value=f"{indices[0]} – {indices[-1]}")
            children.append(label)
            def update_label(change):
                label.value = f"{indices[change['new'][0]]} – {indices[change['new'][1]]}"
            slider.observe(update_label, names='value')
        return widgets.HBox(children=children) 
    
    def try_to_link_sliders_to_cube_widget(self):
        if self.cube_widget.xlim[0] < 0 or self.cube_widget.ylim[0] < 0 or self.cube_widget.zlim[0] < 0:
            self.link_tries_left -= 1
            if self.link_tries_left == 0:
                raise Exception("Error: Cube widget is not initialized yet")
            Timer(1.5, self.try_to_link_sliders_to_cube_widget).start()
            return
        widgets.link((self.cube_widget, 'xlim'), (self.x_axis_slider.children[0], 'value'))
        widgets.link((self.cube_widget, 'ylim'), (self.y_axis_slider.children[0], 'value'))
        widgets.link((self.cube_widget, 'zlim'), (self.z_axis_slider.children[0], 'value'))

    def guess_format(self, index):
        try:
            datetime.datetime.fromisoformat(index)
            return datetime.datetime
        except:
            pass
        try:
            float(index)
            return float
        except:
            pass
        return str

    def format_indices(self, indices):
        t = self.guess_format(indices[0])
        if t == datetime.datetime:
            difference = (datetime.datetime.fromisoformat(indices[-1]) - datetime.datetime.fromisoformat(indices[0])) * 1 / max(1, len(indices) - 1)
            include_month = difference.days < 360
            include_day = difference.days < 30
            include_hour = difference.days < 1
            include_second = difference.seconds < 60
            include_millisecond = difference.microseconds < 1000
            return [datetime.datetime.fromisoformat(index).strftime(f"%Y{'-%m' if include_month else ''}{'-%d' if include_day else ''}{' %H:%M' if include_hour else ''}{'%S' if include_second else ''}{'%f' if include_millisecond else ''}") for index in indices]
        elif t == float and float(indices[-1]) != len(indices) - 1:
            difference = (float(indices[-1]) - float(indices[0])) * 1 / max(1, len(indices) - 1)
            significant_digits = max(0, -int(math.floor(math.log10(abs(difference)))) + 1)
            return [f"{float(index):.{significant_digits}f}" for index in indices]
        return indices

    def __init__(self, cube_widget: Cube3DWidget, dimensions: list, continuous_update: bool, **kwargs):
        self.cube_widget = cube_widget
        self.continuous_update = continuous_update
        self.x_axis_slider = self.make_axis_slider(dimensions[2], (0, cube_widget._data_source.shape[2] - 1), cube_widget.xlim, self.format_indices(cube_widget._indices["x"]))
        self.y_axis_slider = self.make_axis_slider(dimensions[1], (0, cube_widget._data_source.shape[1] - 1), cube_widget.ylim, self.format_indices(cube_widget._indices["y"]))
        self.z_axis_slider = self.make_axis_slider(dimensions[0], (0, cube_widget._data_source.shape[0] - 1), cube_widget.zlim, self.format_indices(cube_widget._indices["z"]))
        super().__init__(children=[self.x_axis_slider, self.y_axis_slider, self.z_axis_slider], **kwargs)
        self.link_tries_left = 5
        self.try_to_link_sliders_to_cube_widget()
