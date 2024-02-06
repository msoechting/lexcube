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
import math
import asyncio
from traitlets import Unicode, Dict, Float, List, Int, validate, TraitError, Bool, Tuple
import traitlets
from typing import Union

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
    vmin = Float(allow_none=True).tag(sync=True)
    vmax = Float(allow_none=True).tag(sync=True)
    cmap = traitlets.Union([Unicode(), List()], allow_none=True).tag(sync=True)
    xlim = Tuple(Int(), Int(), default_value=(-1, -1)).tag(sync=True)
    ylim = Tuple(Int(), Int(), default_value=(-1, -1)).tag(sync=True)
    zlim = Tuple(Int(), Int(), default_value=(-1, -1)).tag(sync=True)

    xwrap = Bool(False).tag(sync=True)
    ywrap = Bool(False).tag(sync=True)
    zwrap = Bool(False).tag(sync=True)

    isometric_mode = Bool(False).tag(sync=True)

    def __init__(self, data_source, cmap: Union[str, list, None] = None, vmin: Union[float, None] = None, vmax: Union[float, None] = None, isometric_mode: bool = False, use_lexcube_chunk_caching: bool = True, **kwargs):
        super().__init__(**kwargs)
        self.cmap = cmap
        self.vmin = vmin
        self.vmax = vmax
        self.isometric_mode = isometric_mode
        self._tile_server, self._dims, self._indices = start_tile_server_in_widget_mode(self, data_source, use_lexcube_chunk_caching)
        self._data_source = self._tile_server.data_source # tile server may have patched/modified data set
        if not self._tile_server:
            raise Exception("Error: Could not start tile server")
        self._tile_server.widget_update_progress = self._update_progress

    def _update_progress(self, progress: list):
        self.request_progress = { "progress": progress.copy() }

    def get_current_cube_selection(self):
        return self._tile_server.data_source[self.zlim[0]:self.zlim[1], self.ylim[0]:self.ylim[1], self.xlim[0]:self.xlim[1]]
    
    def show_sliders(self, continuous_update=True):
        return Sliders(self, self._dims, continuous_update)
    
    def savefig(self, fname: str = "", include_ui: bool = True, dpi_scale: float = 2.0):
        self.send( { "response_type": "download_request", "includeUi": include_ui, "filename": fname, "dpiscale": dpi_scale } )
        return 'When using Lexcube-generated images, please acknowledge/cite: M. Söchting, M. D. Mahecha, D. Montero and G. Scheuermann, "Lexcube: Interactive Visualization of Large Earth System Data Cubes," in IEEE Computer Graphics and Applications, vol. 44, no. 1, pp. 25-37, Jan.-Feb. 2024, doi: https://www.doi.org/10.1109/MCG.2023.3321989.'
        

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
        if proposal < 0 or proposal >= max_value:
            if wrapping:
                raise TraitError(f"Boundary of axis {axis} needs to be within double the range of the data source (considering this dimension wraps around the cube): 0 <= value < {max_value}")
            raise TraitError(f"Boundary of axis {axis} needs to be within the range of the data source: 0 <= value < {max_value}")
        return proposal



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
