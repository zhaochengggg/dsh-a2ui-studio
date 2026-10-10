// @vitest-environment jsdom
import React from 'react';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {IconButton} from '../shared/ui.tsx';
afterEach(cleanup);
it('one accessible refresh primitive handles ready, pending, disabled and keyboard focus',()=>{
 const click=vi.fn(),view=render(<IconButton label="刷新连接" onClick={click}/>);
 const b=screen.getByRole('button',{name:'刷新连接'});fireEvent.click(b);expect(click).toHaveBeenCalledTimes(1);
 expect(b.querySelector('svg')?.getAttribute('width')).toBe('16');expect(b.hasAttribute('data-mgmt-icon-button')).toBe(true);
 view.rerender(<IconButton label="刷新连接" busy onClick={click}/>);fireEvent.click(b);expect(click).toHaveBeenCalledTimes(1);expect(b.getAttribute('aria-busy')).toBe('true');
});
