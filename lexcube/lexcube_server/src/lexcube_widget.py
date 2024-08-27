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

from __future__ import annotations
from .tile_server import TileServer, calculate_max_lod, API_VERSION, get_dimension_labels
from typing import Union
import ipywidgets as widgets
import numpy as np
import xarray as xr


def start_tile_server_in_widget_mode(widget: widgets.DOMWidget, data_source: Union[xr.DataArray, np.ndarray], use_lexcube_chunk_caching: bool):
    if type(data_source) not in [xr.DataArray, np.ndarray]:
        print("Error: Input data is not xarray.DataArray or numpy.ndarray")
        raise Exception("Error: Input data is not xarray.DataArray or numpy.ndarray")
    if len(data_source.shape) != 3:
        print("Error: Data source is not 3-dimensional")
        raise Exception("Error: Data source is not 3-dimensional")

    tile_server = TileServer(widget_mode = True)
    tile_server.startup_widget(data_source, use_lexcube_chunk_caching)
    
    data_source = tile_server.data_source # tile server may have patched/modified data set

    def reply(content, buffers = None):
        widget.send(content, buffers)
    
    def receive_message(widget, content, buffers):
        requests = content["request_data"]
        tile_server.pre_register_requests(requests)
        for request in requests:
            response = tile_server.handle_tile_request_widget(request)
            reply(response[0], response[1])

    if type(data_source) == xr.DataArray:
        dims = data_source.dims
        variable_name = data_source.name
        indices = { "z": get_dimension_labels(data_source, dims[0]), "y": get_dimension_labels(data_source, dims[1]), "x": get_dimension_labels(data_source, dims[2]) }
    else:
        dims = ["Z", "Y", "X"]
        variable_name = "default_var"
        indices = { "z": list(range(data_source.shape[0])), "y": list(range(data_source.shape[1])), "x": list(range(data_source.shape[2])) }

    data_source_name = f"{type(data_source)}"

    data_attributes = {}
    if type(data_source) == xr.DataArray:
        data_attributes = data_source.attrs

    widget.api_metadata = {
        "/api": {"status":"ok", "api_version": API_VERSION},
        "/api/datasets": [{ "id": "default", "shortName": data_source_name }],
        "/api/datasets/default": { 
            "dims": { f"{dims[0]}": data_source.shape[0], f"{dims[1]}": data_source.shape[1], f"{dims[2]}": data_source.shape[2] },
            "dims_ordered": dims,
            "attrs": { },
            "data_vars": { variable_name: { "attrs": data_attributes }}, 
            "indices": indices, 
            "max_lod": calculate_max_lod(tile_server.TILE_SIZE, data_source.shape), 
            "sparsity": 1
        }
    }

    widget.on_msg(receive_message)

    return (tile_server, dims, indices)
