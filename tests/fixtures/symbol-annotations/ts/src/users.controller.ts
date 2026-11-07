// Synthetic fixture (M5-10): TypeScript decorators and TSDoc tags on symbols.

/**
 * Users endpoint.
 * @internal
 * @deprecated use
 *   UsersV2Controller
 */
@Controller('users')
export class UsersController {
  /** The page size. @see inline-not-a-tag */
  @Input() pageSize: number = 10;

  /**
   * Finds one user. See {@link UsersService}.
   * @param id the user id
   * @since 1.2
   */
  @Get(':id')
  @UseGuards(
    AuthGuard,
    RolesGuard,
  )
  find(@Param('id') id: string) {
    return id;
  }

  plain() {
    return 1;
  }
}

export @Injectable() class UsersService {}

/** @internal */
export const helper = () => 1;
