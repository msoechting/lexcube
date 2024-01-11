/*
    Lexcube - Interactive 3D Data Cube Visualization
    Copyright (C) 2022 Maximilian Söchting <maximilian.soechting@uni-leipzig.de>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as widgets from '@jupyter-widgets/base';
import * as services from '@jupyterlab/services';

let numComms = 0;

export class MockComm implements widgets.IClassicComm {
  constructor() {
    this.comm_id = `mock-comm-id-${numComms}`;
    numComms += 1;
  }
  on_close(fn: ((x?: any) => void) | null): void {
    this._on_close = fn;
  }
  on_msg(fn: (x?: any) => void): void {
    this._on_msg = fn;
  }
  _process_msg(msg: services.KernelMessage.ICommMsgMsg): void | Promise<void> {
    if (this._on_msg) {
      return this._on_msg(msg);
    } else {
      return Promise.resolve();
    }
  }
  close(): string {
    if (this._on_close) {
      this._on_close();
    }
    return 'dummy';
  }
  send(): string {
    return 'dummy';
  }

  open(): string {
    return 'dummy';
  }

  comm_id: string;
  target_name = 'dummy';
  _on_msg: ((x?: any) => void) | null = null;
  _on_close: ((x?: any) => void) | null = null;
}

export class DummyManager extends widgets.ManagerBase<HTMLElement> {
  constructor() {
    super();
    this.el = window.document.createElement('div');
  }

  display_view(
    msg: services.KernelMessage.IMessage,
    view: widgets.DOMWidgetView,
    options: any
  ) {
    // TODO: make this a spy
    // TODO: return an html element
    return Promise.resolve(view).then((view) => {
      this.el.appendChild(view.el);
      view.on('remove', () => console.log('view removed', view));
      return view.el;
    });
  }

  protected loadClass(
    className: string,
    moduleName: string,
    moduleVersion: string
  ): Promise<any> {
    if (moduleName === '@jupyter-widgets/base') {
      if ((widgets as any)[className]) {
        return Promise.resolve((widgets as any)[className]);
      } else {
        return Promise.reject(`Cannot find class ${className}`);
      }
    } else if (moduleName === 'jupyter-datawidgets') {
      if (this.testClasses[className]) {
        return Promise.resolve(this.testClasses[className]);
      } else {
        return Promise.reject(`Cannot find class ${className}`);
      }
    } else {
      return Promise.reject(`Cannot find module ${moduleName}`);
    }
  }

  _get_comm_info() {
    return Promise.resolve({});
  }

  _create_comm() {
    return Promise.resolve(new MockComm());
  }

  el: HTMLElement;

  testClasses: { [key: string]: any } = {};
}

export interface Constructor<T> {
  new (attributes?: any, options?: any): T;
}

export function createTestModel<T extends widgets.WidgetModel>(
  constructor: Constructor<T>,
  attributes?: any
): T {
  const id = widgets.uuid();
  const widget_manager = new DummyManager();
  const modelOptions = {
    widget_manager: widget_manager,
    model_id: id,
  };

  return new constructor(attributes, modelOptions);
}